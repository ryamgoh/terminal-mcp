import pino, { type Logger } from 'pino';

/** Diagnostics go to stderr: in stdio mode stdout carries the MCP protocol and must stay clean. */
export const log: Logger = pino({ name: 'terminal-mcp', level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

/** Append-only JSONL audit trail of every tool call (what ran, where, outcome, duration). */
export function createAuditLog(file: string): Logger {
  return pino(
    { base: null, timestamp: pino.stdTimeFunctions.isoTime, formatters: { level: (label) => ({ level: label }) } },
    pino.destination({ dest: file, mkdir: true, sync: false }),
  );
}

const MAX_ARG_CHARS = 2000;

/** Keep audit lines bounded; long inputs (pastes, scripts) are truncated, not dropped. */
export function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > MAX_ARG_CHARS ? `${v.slice(0, MAX_ARG_CHARS)}...[${v.length - MAX_ARG_CHARS} more]` : v;
  }
  return out;
}
