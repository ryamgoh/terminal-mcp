import { EventEmitter, once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { constants as osConstants, homedir } from 'node:os';
import fs from 'node:fs';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import xterm from '@xterm/headless';
import type { IMarker, Terminal as TerminalType } from '@xterm/headless';
import treeKill from 'tree-kill';
import type { Limits, SessionDefaults } from '../config.js';
import { Journal } from './journal.js';
import { bufferText, renderText, screenSnapshot, type ScreenSnapshot } from './render.js';
import { encodeKey } from './keys.js';
import { ttyModes } from './tty.js';
import { decodeOscValue, resolveShell, shellLaunch, type ShellKind } from './shell.js';

const { Terminal } = xterm;

export interface StartOptions {
  command?: string;
  args?: string[];
  shell?: string;
  login?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
}

export type WaitReason = 'ready' | 'command_finished' | 'exited' | 'matched' | 'output' | 'settled' | 'timeout' | 'idle';
export type ShellState = 'idle' | 'busy' | 'unknown' | 'n/a';

export interface CommandRecord {
  command: string | null;
  exit_code: number | null;
  output: string;
  /** True when the start of the command's output scrolled out of the emulator's scrollback. */
  output_head_lost: boolean;
  started_at: string;
  duration_ms: number;
}

export interface InputState {
  awaiting_input: boolean;
  /** "password": the program turned terminal echo off (getpass, sudo, ssh). "prompt": the cursor line looks like a prompt. */
  input_kind: 'password' | 'prompt' | null;
}

// Programs waiting at a prompt usually leave the cursor after text like these.
const PROMPT_RE = /(\[y\/n\]|\(y\/n\)|\(yes\/no[^)]*\)|password[^:]*:|passphrase[^:]*:|continue\?|[?:>$#\u00bb\u276f])$/i;
const STRIP_ENV = /^(TERMINAL_MCP_|VSCODE_)/;

function signalName(signal: number): string {
  for (const [name, num] of Object.entries(osConstants.signals)) if (num === signal) return name;
  return String(signal);
}

/**
 * Quote text as a bash ANSI-C string ($'…', supported since bash 2). Newlines, tabs and other control
 * characters become escapes, so readline receives one plain line and never runs completion or edits.
 */
export function ansiCQuote(text: string): string {
  const body = text.replace(/[\\'\u0000-\u001f\u007f]/g, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === "'") return "\\'";
    if (ch === '\n') return '\\n';
    if (ch === '\t') return '\\t';
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  return `$'${body}'`;
}

function childEnv(extra: Record<string, string> | undefined, sessionId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.test(k)) env[k] = v;
  env.TERM = 'xterm-256color';
  env.TERM_PROGRAM = 'terminal-mcp';
  env.TERMINAL_MCP_SESSION = sessionId;
  // Agents cannot drive an interactive pager; programs print straight to the terminal instead.
  env.PAGER = 'cat';
  env.GIT_PAGER = 'cat';
  if (!env.LANG && !env.LC_ALL) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return { ...env, ...extra };
}

function killTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  return new Promise((resolve) => treeKill(pid, signal, () => resolve()));
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly name: string | null;
  readonly kind: 'shell' | 'program';
  readonly shellKind: ShellKind | null;
  readonly file: string;
  readonly args: string[];
  readonly pid: number;
  readonly createdAt = Date.now();

  state: 'running' | 'exited' = 'running';
  exitCode: number | null = null;
  exitSignal: string | null = null;
  exitedAt: number | null = null;
  integration: 'vscode-osc633' | 'none' = 'none';
  shellState: ShellState;
  cwd: string;
  currentCommand: string | null = null;
  commandStartedAt: number | null = null;
  lastCommand: CommandRecord | null = null;
  commandsFinished = 0;
  sawPrompt = false;
  /** Prompts drawn since the last command finished; the shell reports cwd (P;Cwd) between D and the prompt. */
  promptsSinceCommand = 0;
  lastOutputAt = Date.now();
  lastTouchedAt = Date.now();

  private readonly pty: IPty;
  private readonly term: TerminalType;
  private readonly journal: Journal;
  private readonly preventHistory: boolean;
  private execMarker: IMarker | null = null;
  private pendingParses = 0;
  /** Set once the shell has ever enabled bracketed paste (ESC[?2004h). bash 3.2, macOS's /bin/bash, never does. */
  private bracketedPasteSeen = false;
  /**
   * Exact text of the command terminal_exec just submitted. Reported instead of the shell's E mark, which
   * for bash is $BASH_COMMAND: only the first simple command of a multi-line block, or the `eval` line.
   */
  private submitted: string | null = null;

  constructor(opts: StartOptions, private readonly limits: Limits, defaults: SessionDefaults) {
    super();
    this.setMaxListeners(0);
    this.id = `term_${randomBytes(4).toString('hex')}`;
    this.name = opts.name ?? null;
    this.preventHistory = defaults.preventHistory;
    const cols = opts.cols ?? defaults.cols;
    const rows = opts.rows ?? defaults.rows;
    const cwd = opts.cwd ?? homedir();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
    this.cwd = cwd;

    const baseEnv = childEnv(opts.env, this.id);
    let env = baseEnv;
    if (opts.command) {
      this.kind = 'program';
      this.shellKind = null;
      this.file = opts.command;
      this.args = opts.args ?? [];
      this.shellState = 'n/a';
    } else {
      const launch = shellLaunch(resolveShell(opts.shell), {
        login: opts.login ?? defaults.login,
        preventHistory: defaults.preventHistory,
        baseEnv,
      });
      this.kind = 'shell';
      this.shellKind = launch.kind;
      this.file = launch.file;
      this.args = launch.args;
      env = { ...baseEnv, ...launch.env };
      this.shellState = 'unknown';
    }

    this.journal = new Journal(limits.journalChars);
    this.term = new Terminal({ cols, rows, scrollback: limits.scrollbackLines, allowProposedApi: true });
    this.term.parser.registerOscHandler(633, (data) => {
      this.onShellMark(data);
      return true;
    });
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(2004)) this.bracketedPasteSeen = true;
      return false; // let xterm apply the mode as usual
    });

    this.pty = pty.spawn(this.file, this.args, { name: 'xterm-256color', cols, rows, cwd, env });
    this.pid = this.pty.pid;
    this.pty.onData((data) => {
      this.journal.append(data);
      this.lastOutputAt = Date.now();
      this.pendingParses++;
      this.term.write(data, () => {
        this.pendingParses--;
        this.emit('change');
      });
    });
    this.pty.onExit(({ exitCode, signal }) => {
      // Queue behind pending output so the final screen and command marks are parsed first.
      this.term.write('', () => {
        // The shell died mid-command (e.g. `exit 3`, or it was killed): its exit status is the best answer.
        if (this.execMarker || this.shellState === 'busy') this.finishCommand(signal ? 128 + signal : exitCode);
        this.state = 'exited';
        this.exitCode = exitCode;
        this.exitSignal = signal ? signalName(signal) : null;
        this.exitedAt = Date.now();
        if (this.kind === 'shell') this.shellState = 'unknown';
        this.emit('change');
        this.emit('exit');
      });
    });
  }

  /** OSC 633 marks emitted by the injected VS Code shell-integration scripts. */
  private onShellMark(data: string): void {
    const sep = data.indexOf(';');
    const code = sep < 0 ? data : data.slice(0, sep);
    const rest = sep < 0 ? '' : data.slice(sep + 1);
    switch (code) {
      case 'A':
      case 'B':
        this.integration = 'vscode-osc633';
        this.sawPrompt = true;
        if (code === 'A') this.submitted = null; // a new prompt without E: the submission never started
        if (code === 'B') this.promptsSinceCommand++;
        if (!this.execMarker) this.shellState = 'idle';
        break;
      case 'E':
        {
          const line = decodeOscValue(rest.split(';')[0] ?? '').trim() || null;
          this.currentCommand = this.submitted ?? line;
          this.submitted = null;
        }
        break;
      case 'C':
        this.execMarker?.dispose();
        this.execMarker = this.term.registerMarker(0) ?? null;
        this.shellState = 'busy';
        this.commandStartedAt = Date.now();
        break;
      case 'D': {
        if (!this.execMarker && this.shellState !== 'busy') break; // first prompt / empty line
        const exit = rest ? Number.parseInt(rest.split(';')[0], 10) : Number.NaN;
        this.finishCommand(Number.isFinite(exit) ? exit : null);
        break;
      }
      case 'P':
        if (rest.startsWith('Cwd=')) this.cwd = decodeOscValue(rest.slice(4));
        break;
      default:
        break;
    }
  }

  /** Capture the command's output from the emulator buffer between its start mark and the cursor. */
  private finishCommand(exitCode: number | null): void {
    const buf = this.term.buffer.normal;
    const marker = this.execMarker;
    const headLost = !marker || marker.isDisposed || marker.line < 0;
    const startLine = headLost ? 0 : marker.line;
    const endLine = buf.baseY + buf.cursorY;
    const started = this.commandStartedAt ?? Date.now();
    this.lastCommand = {
      command: this.currentCommand,
      exit_code: exitCode,
      output: bufferText(buf, startLine, endLine, buf.cursorX),
      output_head_lost: headLost && marker !== null,
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
    };
    marker?.dispose();
    this.execMarker = null;
    this.currentCommand = null;
    this.commandStartedAt = null;
    this.commandsFinished++;
    this.promptsSinceCommand = 0;
    this.shellState = 'idle';
  }

  get cursor(): number {
    return this.journal.end;
  }

  get oldestCursor(): number {
    return this.journal.start;
  }

  get cols(): number {
    return this.term.cols;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  private assertRunning(): void {
    if (this.state !== 'running') {
      throw new Error(`Session ${this.id} has exited (exit code ${this.exitCode ?? 'n/a'}${this.exitSignal ? `, signal ${this.exitSignal}` : ''}). Start a new one with terminal_start.`);
    }
  }

  /** Resolve on the next parsed output or state change, or after `ms`. */
  private async nextChange(ms: number): Promise<void> {
    if (ms <= 0) return;
    const ac = new AbortController();
    try {
      await Promise.race([once(this, 'change', { signal: ac.signal }), sleep(ms, undefined, { signal: ac.signal })]);
    } catch {
      // aborted by the winner of the race
    } finally {
      ac.abort();
    }
  }

  /**
   * Event-driven wait. Returns as soon as `done` reports a reason, the `until` regex matches the
   * rendered output after `until.from`, output has been quiet for `settleMs`, the process exits,
   * or the (clamped) timeout expires.
   */
  async waitFor(opts: {
    timeoutMs: number;
    done?: () => WaitReason | null;
    until?: { regex: RegExp; from: number };
    settleMs?: number;
    settleFrom?: number;
  }): Promise<WaitReason> {
    const deadline = Date.now() + Math.min(Math.max(0, opts.timeoutMs), this.limits.maxWaitMs);
    let lastRenderedEnd = -1;
    let lastRenderAt = 0;
    for (;;) {
      const reason = opts.done?.();
      if (reason) return reason;
      if (opts.until && this.journal.end !== lastRenderedEnd && Date.now() - lastRenderAt >= 100) {
        lastRenderedEnd = this.journal.end;
        lastRenderAt = Date.now();
        if (opts.until.regex.test(await this.renderSince(opts.until.from, 256_000))) return 'matched';
      }
      if (this.state === 'exited') return 'exited';
      const now = Date.now();
      const quietFor = now - Math.max(this.lastOutputAt, opts.settleFrom ?? 0);
      if (opts.settleMs !== undefined && this.pendingParses === 0 && quietFor >= opts.settleMs) return 'settled';
      if (now >= deadline) return 'timeout';
      let tick = deadline - now;
      if (opts.settleMs !== undefined) tick = Math.min(tick, Math.max(10, opts.settleMs - quietFor));
      if (opts.until) tick = Math.min(tick, 100);
      await this.nextChange(tick);
    }
  }

  waitReady(timeoutMs: number): Promise<WaitReason> {
    if (this.kind === 'shell') return this.waitFor({ timeoutMs, done: () => (this.sawPrompt ? 'ready' : null) });
    return this.waitProgramReady(timeoutMs);
  }
  /**
   * Programs: wait for their first output, then until it has been quiet for 300 ms. Settling from launch would
   * report a slow starter (python cold-starting on a busy machine) as ready before it has printed its prompt.
   */
  private async waitProgramReady(timeoutMs: number): Promise<WaitReason> {
    const started = Date.now();
    const first = await this.waitFor({ timeoutMs, done: () => (this.journal.end > 0 ? 'output' : null) });
    if (first !== 'output') return first;
    return this.waitFor({ timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)), settleMs: 300 });
  }

  async waitExit(timeoutMs: number): Promise<boolean> {
    if (this.state === 'exited') return true;
    return (await this.waitFor({ timeoutMs, done: () => (this.state === 'exited' ? 'exited' : null) })) === 'exited';
  }

  /** After a command finishes, wait (briefly) for the next prompt so cwd and input readiness are up to date. */
  async waitPromptAfterCommand(timeoutMs = 500): Promise<void> {
    if (this.kind !== 'shell' || this.state !== 'running' || this.promptsSinceCommand > 0) return;
    await this.waitFor({ timeoutMs, done: () => (this.promptsSinceCommand > 0 ? 'ready' : null) });
  }

  /** Rendered plain text of raw output after `from` (at most the last `maxRaw` raw characters). */
  async renderSince(from: number, maxRaw: number): Promise<string> {
    const slice = this.journal.read(Math.max(from, this.journal.end - maxRaw), maxRaw);
    return renderText(slice.raw, this.term.cols);
  }

  /** Cursor-paged read of rendered output. Shrinks the raw window until the rendered page fits. */
  async readPage(cursor: number, maxChars: number): Promise<{ text: string; from: number; next: number; lost: boolean; hasMore: boolean }> {
    let window = maxChars * 4;
    for (let attempt = 0; ; attempt++) {
      const slice = this.journal.read(cursor, window);
      const text = await renderText(slice.raw, this.term.cols);
      if (text.length <= maxChars || attempt >= 3 || window <= 1024) return { text, from: slice.from, next: slice.next, lost: slice.lost, hasMore: slice.hasMore };
      window = Math.floor(window / 2);
    }
  }

  /** The last `lines` lines of rendered output after `from` (or of all retained output). */
  async readTail(from: number | undefined, lines: number): Promise<{ text: string; from: number; lost: boolean; skipped_lines: number }> {
    const start = from === undefined ? this.journal.start : from;
    const lost = from !== undefined && from < this.journal.start;
    const text = await this.renderSince(Math.max(start, this.journal.start), 512_000);
    const all = text ? text.split('\n') : [];
    const kept = all.slice(-lines);
    return { text: kept.join('\n'), from: Math.max(start, this.journal.start), lost, skipped_lines: all.length - kept.length };
  }

  screen(): ScreenSnapshot {
    return screenSnapshot(this.term);
  }

  /** Write literal text (optionally as a bracketed paste) followed by named keys. Returns characters written. */
  write(input: string, keys: string[], paste: boolean): number {
    this.assertRunning();
    let data = '';
    if (input) data += paste && this.term.modes.bracketedPasteMode ? `\x1b[200~${input}\x1b[201~` : input;
    for (const key of keys) data += encodeKey(key, this.term.modes.applicationCursorKeysMode);
    if (data) this.pty.write(data);
    this.touch();
    return data.length;
  }

  /** Type a command line into an idle tracked shell. Completion is reported by the shell's D mark. */
  async submitCommand(command: string): Promise<void> {
    this.assertRunning();
    if (this.kind !== 'shell') {
      throw new Error('terminal_exec only works in shell sessions (terminal_start without "command"). For other programs use terminal_write and terminal_read.');
    }
    if (this.integration === 'none') {
      throw new Error('Command tracking is not active in this shell (its startup files may have disabled shell integration). Use terminal_write with input "<command>\\r" and terminal_read instead.');
    }
    if (this.shellState === 'busy') {
      throw new Error(
        `The shell is still running ${this.currentCommand ? `"${this.currentCommand}"` : 'a previous command'}. ` +
          'Wait with terminal_read {wait_for:"command_end"}, answer it with terminal_write, or interrupt it with terminal_write {keys:["ctrl+c"]}.',
      );
    }
    const text = command.replace(/\r?\n$/, '');
    if (!text.trim()) throw new Error('command is empty');
    // A leading space keeps agent commands out of the user's history (HISTCONTROL=ignorespace / HIST_IGNORE_SPACE).
    let data = (this.preventHistory ? ' ' : '') + text;
    if (text.includes('\n')) {
      // Readline/ZLE re-enable bracketed paste (ESC[?2004h) just after drawing the prompt; give them a moment.
      if (!this.term.modes.bracketedPasteMode && this.bracketedPasteSeen) {
        await this.waitFor({ timeoutMs: 1500, done: () => (this.term.modes.bracketedPasteMode ? 'ready' : null) });
      }
      if (this.term.modes.bracketedPasteMode) {
        data = `\x1b[200~${data}\x1b[201~`;
      } else if (this.shellKind === 'bash') {
        // bash < 4.4 (macOS's /bin/bash is 3.2) has no bracketed paste. Submit the lines as one line that
        // runs them in the current shell, so cd/export/heredocs behave exactly as if typed.
        data = (this.preventHistory ? ' ' : '') + `eval ${ansiCQuote(text)}`;
      } else {
        throw new Error('Multi-line commands need bracketed paste, which this shell has not enabled. Join the lines with ";" or "&&", or write a script file and run it.');
      }
    }
    this.submitted = text;
    this.pty.write(`${data}\r`);
    this.touch();
  }

  async inputState(): Promise<InputState> {
    const none: InputState = { awaiting_input: false, input_kind: null };
    if (this.state !== 'running' || this.pendingParses > 0) return none;
    // An idle shell is at its own prompt. A shell that has not reported a prompt yet ('unknown') may be stuck on
    // a startup question (zsh's compinit insecure-directories check, a y/n in ~/.zshrc), so probe it like a busy one.
    if (this.kind === 'shell' && this.shellState === 'idle') return none;
    // Same quiet window terminal_start/terminal_write use to decide output has settled.
    if (Date.now() - this.lastOutputAt < 250) return none;
    const modes = await ttyModes((this.pty as unknown as { ptsName?: string }).ptsName);
    if (modes && !modes.echo && modes.canonical) return { awaiting_input: true, input_kind: 'password' };
    const buf = this.term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '';
    if (line && PROMPT_RE.test(line.trimEnd())) return { awaiting_input: true, input_kind: 'prompt' };
    return none;
  }

  /** Terminate the whole process tree: `signal` first, SIGKILL after `escalateAfterMs`. */
  async kill(signal: NodeJS.Signals, escalateAfterMs: number): Promise<void> {
    if (this.state === 'exited') return;
    await killTree(this.pid, signal);
    if (await this.waitExit(escalateAfterMs)) return;
    await killTree(this.pid, 'SIGKILL');
    await this.waitExit(3000);
  }

  /** Synchronous last-resort cleanup for process exit. */
  killNow(): void {
    if (this.state === 'exited') return;
    try {
      process.kill(-this.pid, 'SIGKILL');
    } catch {
      // process group already gone
    }
    try {
      this.pty.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  dispose(): void {
    this.killNow();
    this.term.dispose();
    this.removeAllListeners();
  }

  status() {
    const now = Date.now();
    return {
      session_id: this.id,
      name: this.name,
      kind: this.kind,
      shell: this.shellKind,
      command: this.kind === 'program' ? [this.file, ...this.args].join(' ') : null,
      pid: this.pid,
      state: this.state,
      exit_code: this.exitCode,
      exit_signal: this.exitSignal,
      integration: this.integration,
      shell_state: this.shellState,
      cwd: this.cwd,
      current_command: this.currentCommand,
      running_for_ms: this.commandStartedAt ? now - this.commandStartedAt : null,
      last_command: this.lastCommand
        ? { command: this.lastCommand.command, exit_code: this.lastCommand.exit_code, duration_ms: this.lastCommand.duration_ms }
        : null,
      cursor: this.journal.end,
      quiet_for_ms: now - this.lastOutputAt,
      created_at: new Date(this.createdAt).toISOString(),
    };
  }
}

export type SessionStatus = ReturnType<Session['status']>;
