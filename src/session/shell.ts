import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shell integration is NOT implemented here: we inject Microsoft's VS Code shell-integration scripts
 * (vendored unmodified under shell-integration/vscode, MIT) exactly the way VS Code launches them.
 * They emit OSC 633 marks for prompt start, command start, command end with exit code, the command
 * line and the working directory, and they take care of loading the user's own rc/profile files.
 */
export type ShellKind = 'bash' | 'zsh';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shell-integration', 'vscode');
/** Our 10-line bash wrapper: sources VS Code's script, then turns history off for agent shells. */
const BASH_INIT = path.resolve(SCRIPTS_DIR, '..', 'terminal-mcp-bash.sh');

export interface ShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  kind: ShellKind;
}

export function resolveShell(requested: string | undefined): { file: string; kind: ShellKind } {
  const choice = requested && requested !== 'auto' ? requested : process.env.SHELL || os.userInfo().shell || '/bin/bash';
  const base = path.basename(choice);
  if (base === 'zsh' || base === 'bash') return { file: choice, kind: base };
  // Unsupported login shell (fish, sh, ...): fall back to bash so command tracking still works.
  return { file: 'bash', kind: 'bash' };
}

let zdotdir: string | null = null;

/** VS Code's zsh injection: a private ZDOTDIR whose startup files chain to the user's real ones. */
function zshDotDir(): string {
  if (zdotdir && fs.existsSync(zdotdir)) return zdotdir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `terminal-mcp-${os.userInfo().username}-zsh-`));
  const copy = (src: string, dest: string, extra = '') =>
    fs.writeFileSync(path.join(dir, dest), fs.readFileSync(path.join(SCRIPTS_DIR, src), 'utf8') + extra);
  copy('shellIntegration-env.zsh', '.zshenv');
  copy('shellIntegration-profile.zsh', '.zprofile');
  copy('shellIntegration-login.zsh', '.zlogin');
  // Agent output should not contain zsh's PROMPT_SP end-of-line mark ("%") after output lacking a newline.
  copy('shellIntegration-rc.zsh', '.zshrc', "\n# terminal-mcp: no end-of-line mark in captured output\nPROMPT_EOL_MARK=''\n");
  zdotdir = dir;
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function shellLaunch(
  shell: { file: string; kind: ShellKind },
  opts: { login: boolean; preventHistory: boolean; baseEnv: Record<string, string> },
): ShellLaunch {
  const env: Record<string, string> = { VSCODE_INJECTION: '1' };
  if (opts.preventHistory) env.VSCODE_PREVENT_SHELL_HISTORY = '1';
  if (shell.kind === 'bash') {
    if (opts.login) env.VSCODE_SHELL_LOGIN = '1';
    if (opts.preventHistory) env.TERMINAL_MCP_NO_HISTORY = '1';
    return { file: shell.file, kind: 'bash', args: ['--init-file', BASH_INIT], env };
  }
  env.ZDOTDIR = zshDotDir();
  env.USER_ZDOTDIR = opts.baseEnv.ZDOTDIR || os.homedir();
  env.VSCODE_AGENT_ZSH_FIXUPS = '1';
  return { file: shell.file, kind: 'zsh', args: opts.login ? ['-il'] : ['-i'], env };
}

/** VS Code escapes OSC 633 values: `\\` for a backslash and `\xHH` for other bytes. */
export function decodeOscValue(value: string): string {
  return value.replace(/\\\\|\\x([0-9a-fA-F]{2})/g, (m, hex: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : '\\'));
}
