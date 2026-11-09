#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Command, Option } from 'commander';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DEFAULT_LIMITS, DEFAULT_SESSION, SERVER_NAME, SERVER_VERSION } from './config.js';
import { createAuditLog, log } from './audit.js';
import { SessionManager } from './session/manager.js';
import { buildServerFactory } from './server.js';
import { startHttp } from './http.js';
import { ensureSpawnHelperExecutable } from './fix-node-pty.js';

const STATE_DIR = path.join(os.homedir(), '.terminal-mcp');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const program = new Command()
  .name(SERVER_NAME)
  .version(SERVER_VERSION)
  .description('MCP server that lets agents create and control real terminal sessions. Default transport: stdio.')
  .option('--http', 'serve Streamable HTTP instead of stdio')
  .option('--host <addr>', 'HTTP bind address', '127.0.0.1')
  .option('--port <n>', 'HTTP port', (v) => Number.parseInt(v, 10), 8765)
  .option('--allowed-host <name...>', 'extra Host header names to accept (e.g. your tunnel hostname)', [])
  .option('--allowed-origin <name...>', 'Origin hostnames to accept from browser-based clients', [])
  .option('--allow-any-host', 'accept any Host header (bearer token still required)')
  .addOption(new Option('--token <token>', 'bearer token for HTTP (default: $TERMINAL_MCP_TOKEN or ~/.terminal-mcp/token)').env('TERMINAL_MCP_TOKEN'))
  .option('--no-auth', 'disable bearer auth (only allowed on a loopback bind)')
  .option('--url-token', 'also accept the token as a secret URL path (/mcp/<token>) for clients that cannot send headers')
  .option('--max-sessions <n>', 'maximum running sessions', (v) => Number.parseInt(v, 10), DEFAULT_LIMITS.maxSessions)
  .option('--idle-timeout <minutes>', 'kill sessions untouched for this long; 0 disables', (v) => Number.parseFloat(v), DEFAULT_LIMITS.idleTimeoutMs / 60_000)
  .option('--max-wait <seconds>', 'hard cap on any blocking wait inside a tool call', (v) => Number.parseFloat(v), DEFAULT_LIMITS.maxWaitMs / 1000)
  .option('--audit-log <file>', 'JSONL audit log of tool calls', path.join(STATE_DIR, 'audit.jsonl'))
  .option('--no-audit', 'disable the audit log')
  .option('--keep-history', 'let agent commands into your shell history (default: hidden, like VS Code agent terminals)')
  .parse();

const opts = program.opts<{
  http?: boolean;
  host: string;
  port: number;
  allowedHost: string[];
  allowedOrigin: string[];
  allowAnyHost?: boolean;
  token?: string;
  auth: boolean;
  urlToken?: boolean;
  maxSessions: number;
  idleTimeout: number;
  maxWait: number;
  auditLog: string;
  audit: boolean;
  keepHistory?: boolean;
}>();

if (process.platform === 'darwin') {
  for (const helper of ensureSpawnHelperExecutable()) {
    process.stderr.write(`terminal-mcp: restored the execute bit on ${helper} (node-pty#850)\n`);
  }
}

function loadOrCreateToken(): string {
  const file = path.join(STATE_DIR, 'token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  process.stderr.write(`terminal-mcp: generated a bearer token and saved it to ${file}\n`);
  return token;
}

const manager = new SessionManager(
  {
    ...DEFAULT_LIMITS,
    maxSessions: opts.maxSessions,
    idleTimeoutMs: opts.idleTimeout * 60_000,
    maxWaitMs: opts.maxWait * 1000,
  },
  { ...DEFAULT_SESSION, preventHistory: !opts.keepHistory },
);
const audit = opts.audit ? createAuditLog(opts.auditLog) : null;
const buildServer = buildServerFactory(manager, audit);

let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  await manager.shutdown();
  audit?.flush();
  process.exit(code);
}
process.on('SIGINT', () => void stop(130));
process.on('SIGTERM', () => void stop(143));
process.on('SIGHUP', () => void stop(129));
process.on('exit', () => manager.killAllNow());
process.on('uncaughtException', (err) => {
  log.error({ err }, 'uncaught exception; shutting down');
  void stop(1);
});

if (opts.http) {
  if (!opts.auth && !LOOPBACK.has(opts.host)) {
    process.stderr.write('terminal-mcp: refusing --no-auth on a non-loopback bind. Remove --no-auth or bind to 127.0.0.1.\n');
    process.exit(2);
  }
  const token = opts.auth ? (opts.token ?? loadOrCreateToken()) : null;
  const server = await startHttp(buildServer, {
    host: opts.host,
    port: opts.port,
    token,
    allowedHosts: opts.allowedHost,
    allowedOrigins: opts.allowedOrigin,
    allowAnyHost: Boolean(opts.allowAnyHost),
    urlToken: Boolean(opts.urlToken),
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  process.stderr.write(
    `terminal-mcp ${SERVER_VERSION} listening on http://${opts.host}:${port}/mcp (auth: ${token ? 'bearer token' : 'DISABLED'}${opts.allowAnyHost ? ', any Host' : opts.allowedHost.length ? `, hosts: ${opts.allowedHost.join(', ')}` : ', localhost only'})\n`,
  );
  if (token && opts.urlToken) process.stderr.write('terminal-mcp: URL-token mode on; clients without headers can use .../mcp/<token>\n');
} else {
  await serveStdio(buildServer);
  // The client owns our lifetime in stdio mode: when it goes away, clean up every terminal we started.
  process.stdin.on('end', () => void stop(0));
  process.stdin.on('close', () => void stop(0));
}
