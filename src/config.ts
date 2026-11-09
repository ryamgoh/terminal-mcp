/** Limits and defaults. Every wait is clamped to maxWaitMs so no tool call can hang a client. */
import fs from 'node:fs';

export interface Limits {
  /** Maximum number of sessions that may be running at once. */
  maxSessions: number;
  /** Raw output (UTF-16 code units) retained per session for cursor reads. Older output is dropped and reported as output_lost. */
  journalChars: number;
  /** Lines of scrollback kept by the terminal emulator; bounds per-command output capture. */
  scrollbackLines: number;
  /** Hard cap for any blocking wait inside a tool call. */
  maxWaitMs: number;
  /** Default cap on output characters returned by one tool call. */
  defaultMaxChars: number;
  /** Kill running sessions that no tool call has touched for this long. 0 disables. */
  idleTimeoutMs: number;
  /** How long an exited session stays readable before it is removed. */
  exitedTtlMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxSessions: 16,
  journalChars: 2_000_000,
  scrollbackLines: 10_000,
  maxWaitMs: 60_000,
  defaultMaxChars: 16_000,
  idleTimeoutMs: 60 * 60_000,
  exitedTtlMs: 10 * 60_000,
};

export interface SessionDefaults {
  cols: number;
  rows: number;
  /** Keep agent commands out of the user's shell history (VS Code's VSCODE_PREVENT_SHELL_HISTORY behaviour). */
  preventHistory: boolean;
  /** Start shells as login shells (loads ~/.zprofile / ~/.bash_profile, where Homebrew PATH usually lives on macOS). */
  login: boolean;
}

export const DEFAULT_SESSION: SessionDefaults = {
  cols: 120,
  rows: 32,
  preventHistory: true,
  login: process.platform === 'darwin',
};

export const SERVER_NAME = 'terminal-mcp';
/** From package.json (one level above dist/ in the repo and in an installed package), so releases never drift. */
export const SERVER_VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
