import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Logger } from 'pino';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { auditArgs } from './audit.js';
import type { SessionManager } from './session/manager.js';
import type { Session, WaitReason } from './session/session.js';
import { clip } from './session/render.js';

type Result = { result: Record<string, unknown>; output?: string };

const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'] as const;
const sessionRef = z.string().min(1).describe('session_id returned by terminal_start (a session name also works)');

function compileRegex(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined || pattern === '') return undefined;
  try {
    return new RegExp(pattern, 'm');
  } catch (e) {
    throw new Error(`Invalid "until" regex: ${(e as Error).message}`);
  }
}

/** Text content = compact status JSON plus the output as plain text (easy for models to read). */
function toCallResult({ result, output }: Result) {
  const header = { ...result } as Record<string, unknown>;
  if (output !== undefined && header.output && typeof header.output === 'object') {
    const { text: _text, ...meta } = header.output as Record<string, unknown>;
    header.output = meta;
  }
  const text = JSON.stringify(header, null, 1) + (output !== undefined ? `\n--- output ---\n${output}` : '');
  return { content: [{ type: 'text' as const, text }], structuredContent: result };
}

async function withInput(s: Session, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { ...result, ...(await s.inputState()) };
}

function hintFor(s: Session, reason: WaitReason, extra: { input_kind?: string | null } = {}): string | undefined {
  if (s.state === 'exited') return 'The process has exited. Its output stays readable via terminal_read; start a new session to continue.';
  if (extra.input_kind === 'password') return 'The program is waiting for a secret with echo turned off. Ask the user for it if you do not have it, then send it with terminal_write {input:"...", keys:["enter"]}.';
  if (extra.input_kind === 'prompt') return 'The program appears to be waiting for input. Answer with terminal_write, or press ctrl+c to cancel.';
  if (reason === 'timeout' && s.shellState === 'busy') return 'Still running. Poll with terminal_read {cursor, wait_for:"command_end"}, or interrupt with terminal_write {keys:["ctrl+c"]}.';
  return undefined;
}

export function buildServerFactory(manager: SessionManager, audit: Logger | null) {
  const limits = manager.limits;
  const maxChars = z.number().int().min(500).max(500_000).default(limits.defaultMaxChars).describe('Cap on characters of output returned');

  return function buildServer(): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

    const register = <S extends z.ZodObject>(
      name: string,
      def: { description: string; inputSchema: S; annotations: Record<string, boolean> },
      fn: (args: z.infer<S>) => Promise<Result>,
    ) => {
      server.registerTool(name, def as never, (async (args: z.infer<S>) => {
        const started = Date.now();
        try {
          const res = await fn(args);
          audit?.info({ tool: name, args: auditArgs(args as Record<string, unknown>), ok: true, ms: Date.now() - started, session_id: res.result.session_id, state: res.result.state, exit_code: res.result.exit_code, reason: res.result.reason });
          return toCallResult(res);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          audit?.warn({ tool: name, args: auditArgs(args as Record<string, unknown>), ok: false, ms: Date.now() - started, error: message });
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      }) as never);
    };

    register(
      'terminal_start',
      {
        description:
          'Start a new terminal session (a real PTY) and return its session_id. Omit `command` to get an interactive shell ' +
          '(your login shell, zsh or bash) with command tracking: terminal_exec then reports exit codes, and the busy/idle state ' +
          'and cwd are tracked. Pass `command` (+ `args`) to run any other program directly in a terminal: REPLs, full-screen ' +
          'programs (vim, htop), dev servers, ssh. Sessions keep running between calls until they exit or you call terminal_kill.',
        inputSchema: z.object({
          command: z.string().optional().describe('Program to run instead of a shell, e.g. "python3". Not run through a shell: use args for arguments.'),
          args: z.array(z.string()).optional().describe('Arguments for `command`'),
          shell: z.string().optional().describe('"auto" (default: $SHELL), "bash", "zsh" or a path; only used when `command` is omitted'),
          login: z.boolean().optional().describe('Start the shell as a login shell (default: true on macOS so ~/.zprofile PATH setup is loaded)'),
          cwd: z.string().optional().describe('Working directory (default: home directory)'),
          env: z.record(z.string(), z.string()).optional().describe('Extra environment variables'),
          cols: z.number().int().min(20).max(500).optional().describe('Terminal width (default 120)'),
          rows: z.number().int().min(5).max(200).optional().describe('Terminal height (default 32)'),
          name: z.string().max(64).optional().describe('Optional label; can be used instead of session_id later, e.g. "devserver"'),
          wait_ms: z.number().int().min(0).max(60_000).default(5000).describe('How long to wait for the shell prompt, or for a program\'s first output and then 300 ms of quiet'),
        }),
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      async ({ wait_ms, ...opts }) => {
        const s = manager.start(opts);
        const reason = await s.waitReady(wait_ms);
        const result = await withInput(s, { ...s.status(), reason, screen: s.screen().text });
        let hint: string | undefined;
        if (s.kind === 'shell' && s.integration === 'none' && s.state === 'running') {
          const question = s.screen().text.trimEnd().split('\n').pop()?.trim().slice(0, 200);
          hint = result.awaiting_input
            ? `The shell is asking a question before its first prompt: "${question}". It comes from the user's shell startup files. Answer with terminal_write (for a yes/no question, input "y" or "n"; ask the user if unsure); command tracking starts as soon as the prompt appears.`
            : 'The shell did not report a prompt in time, so command tracking may be unavailable. Check the screen; use terminal_write/terminal_read, or try terminal_exec again shortly.';
        } else {
          hint = hintFor(s, reason, result as { input_kind?: string | null });
        }
        return { result: hint ? { ...result, hint } : result };
      },
    );

    register(
      'terminal_exec',
      {
        description:
          'Run one shell command line in a shell session and wait for it to finish (up to timeout_ms). Returns only that ' +
          "command's output (no prompt or echo), its exit_code and the cwd afterwards. Shell state (cd, export, activated " +
          'virtualenvs) persists between calls. If the command is still running at the timeout it keeps running: you get ' +
          'completed=false plus a cursor; then use terminal_read {wait_for:"command_end"} to wait for it, terminal_write to answer ' +
          'a prompt, or terminal_write {keys:["ctrl+c"]} to interrupt. For REPLs, editors and other interactive programs use terminal_write/terminal_read.',
        inputSchema: z.object({
          session_id: sessionRef,
          command: z.string().min(1).describe('Command line exactly as you would type it, e.g. "npm test -- --watch=false"'),
          timeout_ms: z.number().int().min(100).max(limits.maxWaitMs).default(Math.min(20_000, limits.maxWaitMs)).describe('Max time to wait before returning; the command keeps running afterwards'),
          max_chars: maxChars,
        }),
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      async ({ session_id, command, timeout_ms, max_chars }) => {
        const s = manager.get(session_id);
        const seq = s.commandsFinished;
        const from = s.cursor;
        await s.submitCommand(command);
        const startedAt = Date.now();
        const reason = await s.waitFor({ timeoutMs: timeout_ms, done: () => (s.commandsFinished > seq ? 'command_finished' : null) });
        const completed = s.commandsFinished > seq && s.lastCommand !== null;
        if (completed) await s.waitPromptAfterCommand();
        const status = s.status();
        if (completed) {
          const out = clip(s.lastCommand!.output, max_chars);
          const exited = s.state === 'exited';
          return {
            result: {
              completed: true,
              reason: exited ? 'exited' : 'command_finished',
              exit_code: s.lastCommand!.exit_code,
              command: s.lastCommand!.command ?? command,
              output: { ...out, head_lost: s.lastCommand!.output_head_lost },
              duration_ms: s.lastCommand!.duration_ms,
              cwd: status.cwd,
              cursor: status.cursor,
              session_id: s.id,
              state: status.state,
              shell_state: status.shell_state,
              ...(exited ? { hint: hintFor(s, 'exited') } : {}),
            },
            output: out.text,
          };
        }
        const partial = clip(await s.renderSince(from, 512_000), max_chars);
        const input = await s.inputState();
        let hint = hintFor(s, reason, input);
        if (!hint && s.state === 'running' && s.shellState !== 'busy') {
          hint = 'The shell has not started the command; it may be waiting for more input (unclosed quote, bracket or heredoc). Send keys ["ctrl+c"] to cancel it.';
        }
        return {
          result: { completed: false, reason, exit_code: s.state === 'exited' ? s.exitCode : null, command, output: partial, waited_ms: Date.now() - startedAt, cursor: status.cursor, session_id: s.id, state: status.state, shell_state: status.shell_state, ...input, ...(hint ? { hint } : {}) },
          output: partial.text,
        };
      },
    );

    register(
      'terminal_write',
      {
        description:
          'Send keyboard input to a session: literal text in `input` and/or named `keys`, sent text first. To submit a line end the ' +
          'text with "\\r" or add keys ["enter"]. Key names: enter, tab, escape, backspace, delete, up, down, left, right, home, end, ' +
          'pageup, pagedown, f1-f12, ctrl+<letter> (ctrl+c interrupts, ctrl+d sends EOF), alt+<letter>, shift+tab. Waits until output ' +
          'settles (settle_ms of quiet, at most wait_ms) or `until` matches, then returns the new output as plain text. Use paste=true ' +
          'for multi-line text so shells and editors do not run it line by line.',
        inputSchema: z.object({
          session_id: sessionRef,
          input: z.string().default('').describe('Literal text to type'),
          keys: z.array(z.string()).default([]).describe('Named keys to press after the text, e.g. ["ctrl+c"] or ["down","enter"]'),
          paste: z.boolean().default(false).describe('Send `input` as a bracketed paste when the program supports it'),
          wait_ms: z.number().int().min(0).max(limits.maxWaitMs).default(2000).describe('Max time to wait for output'),
          settle_ms: z.number().int().min(50).max(10_000).default(300).describe('Return once output has been quiet this long'),
          until: z.string().optional().describe('Return as soon as this regex matches the new output'),
          max_chars: maxChars,
        }),
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      async ({ session_id, input, keys, paste, wait_ms, settle_ms, until, max_chars }) => {
        const s = manager.get(session_id);
        const regex = compileRegex(until);
        const from = s.cursor;
        const sentAt = Date.now();
        const written = s.write(input, keys, paste);
        const reason = await s.waitFor({ timeoutMs: wait_ms, settleMs: regex ? undefined : settle_ms, settleFrom: sentAt, until: regex ? { regex, from } : undefined });
        const page = await s.readPage(from, max_chars);
        const out = clip(page.text, max_chars);
        const result = await withInput(s, { reason, chars_written: written, output: { ...out, has_more: page.hasMore }, next_cursor: page.hasMore ? page.next : s.cursor, ...s.status() });
        const hint = hintFor(s, reason, result as { input_kind?: string | null });
        return { result: hint ? { ...result, hint } : result, output: out.text };
      },
    );

    register(
      'terminal_read',
      {
        description:
          'Read session output without sending input. Pass `cursor` (from any earlier response) to get only output produced after it, ' +
          'and keep passing the returned next_cursor to stream a long-running program without missing or repeating output. Omit ' +
          'cursor to get the most recent tail_lines lines. Optionally wait first: wait_for "output" (new output), "command_end" (the ' +
          "running shell command finishes; its clean output and exit code come back in last_command), \"exit\", or `until` (regex). " +
          'view="screen" returns the visible screen instead, for full-screen programs such as vim, top or less. output_lost=true means ' +
          'output after your cursor was discarded (buffer limit) before you read it.',
        inputSchema: z.object({
          session_id: sessionRef,
          cursor: z.number().int().min(0).optional().describe('Read output after this position (next_cursor/cursor from an earlier call)'),
          wait_for: z.enum(['none', 'output', 'command_end', 'exit']).default('none'),
          until: z.string().optional().describe('Wait until this regex matches output after `cursor`'),
          wait_ms: z.number().int().min(0).max(limits.maxWaitMs).optional().describe('Max wait (default 15000 when waiting, else 0)'),
          view: z.enum(['stream', 'screen']).default('stream'),
          tail_lines: z.number().int().min(1).max(5000).optional().describe('Return only the last N lines (default 200 when cursor is omitted)'),
          max_chars: maxChars,
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ session_id, cursor, wait_for, until, wait_ms, view, tail_lines, max_chars }) => {
        const s = manager.get(session_id);
        s.touch();
        const regex = compileRegex(until);
        const from = cursor ?? s.cursor;
        const seq = s.commandsFinished;
        const waiting = wait_for !== 'none' || regex !== undefined;
        let reason: WaitReason = 'output';
        if (waiting) {
          if (wait_for === 'command_end' && s.shellState !== 'busy' && s.state === 'running') reason = 'idle';
          else {
            reason = await s.waitFor({
              timeoutMs: wait_ms ?? 15_000,
              until: regex ? { regex, from } : undefined,
              done: () => {
                if (wait_for === 'command_end' && s.commandsFinished > seq) return 'command_finished';
                if (wait_for === 'output' && s.cursor > from) return 'output';
                return null;
              },
            });
            if (wait_for === 'output' && reason === 'output') await s.waitFor({ timeoutMs: 1000, settleMs: 150 });
            if (reason === 'command_finished') await s.waitPromptAfterCommand();
          }
        }
        const lastCommand =
          s.lastCommand && (reason === 'command_finished' || wait_for === 'command_end')
            ? { ...s.lastCommand, output: clip(s.lastCommand.output, max_chars) }
            : undefined;
        if (view === 'screen') {
          const screen = s.screen();
          const result = await withInput(s, { reason, screen, next_cursor: s.cursor, ...s.status(), ...(lastCommand ? { last_command: lastCommand } : {}) });
          return { result, output: screen.text };
        }
        if (cursor === undefined || tail_lines !== undefined) {
          const tail = await s.readTail(cursor, tail_lines ?? 200);
          const out = clip(tail.text, max_chars);
          const result = await withInput(s, { reason, output: { ...out, skipped_lines: tail.skipped_lines }, output_lost: tail.lost, next_cursor: s.cursor, ...s.status(), ...(lastCommand ? { last_command: lastCommand } : {}) });
          const hint = hintFor(s, reason, result as { input_kind?: string | null });
          return { result: hint ? { ...result, hint } : result, output: out.text };
        }
        const page = await s.readPage(cursor, max_chars);
        const out = clip(page.text, max_chars);
        const result = await withInput(s, { reason, output: { ...out, has_more: page.hasMore }, output_lost: page.lost, next_cursor: page.next, ...s.status(), ...(lastCommand ? { last_command: lastCommand } : {}) });
        const hint = hintFor(s, reason, result as { input_kind?: string | null });
        return { result: hint ? { ...result, hint } : result, output: out.text };
      },
    );

    register(
      'terminal_list',
      {
        description: 'List all sessions with their state (running/exited, exit code), shell state (idle/busy), current command, cwd and latest cursor.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({ result: { sessions: manager.list().map((s) => s.status()) } }),
    );

    register(
      'terminal_kill',
      {
        description:
          'Terminate a session and everything running in it (the whole process tree). Sends SIGHUP by default (what closing a ' +
          'terminal window does) and escalates to SIGKILL after escalate_after_ms. Returns the final status and last lines of output; ' +
          'exited sessions stay readable for a while. To stop only the current command and keep the shell, use terminal_write {keys:["ctrl+c"]} instead.',
        inputSchema: z.object({
          session_id: sessionRef,
          signal: z.enum(SIGNALS).default('SIGHUP'),
          escalate_after_ms: z.number().int().min(0).max(30_000).default(2000),
        }),
        annotations: { destructiveHint: true },
      },
      async ({ session_id, signal, escalate_after_ms }) => {
        const s = manager.get(session_id);
        await s.kill(signal, escalate_after_ms);
        const tail = await s.readTail(undefined, 20);
        return { result: { ...s.status(), output: { text: tail.text } }, output: tail.text };
      },
    );

    return server;
  };
}
