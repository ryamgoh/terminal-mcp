import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { CLI, call, httpClient, pidAlive, sleep, startHttpServer, stdioClient, type Any, type HttpServer } from './helpers.js';

describe('programs, screens and limits (stdio)', () => {
  let client: Client;
  beforeAll(async () => {
    client = await stdioClient('legacy');
  });
  afterAll(async () => {
    await client?.close();
  });

  it('keeps REPL state between writes and exits on ctrl+d', async () => {
    const py = await call(client, 'terminal_start', { command: 'python3', args: ['-q'] });
    expect(py).toMatchObject({ kind: 'program', state: 'running', awaiting_input: true });
    await call(client, 'terminal_write', { session_id: py.session_id, input: 'x = 2**100\r' });
    const out = await call(client, 'terminal_write', { session_id: py.session_id, input: 'print(x)\r' });
    expect(out.output.text).toContain('1267650600228229401496703205376');
    const bye = await call(client, 'terminal_write', { session_id: py.session_id, keys: ['ctrl+d'], wait_ms: 3000 });
    expect(bye).toMatchObject({ state: 'exited', exit_code: 0 });
  });
  it('waits for a slow-starting program to show its prompt before reporting it ready', async () => {
    // Silent for a second, like python cold-starting on a busy machine; readiness must not settle before output.
    const slow = await call(client, 'terminal_start', { command: 'bash', args: ['-c', 'sleep 1; read -r -p "name? " n; echo "hi $n"'] });
    expect(slow, `screen:\n${slow.screen}`).toMatchObject({ kind: 'program', state: 'running', reason: 'settled', awaiting_input: true, input_kind: 'prompt' });
    expect(slow.screen).toContain('name?');
    const out = await call(client, 'terminal_write', { session_id: slow.session_id, input: 'agent\r', wait_ms: 3000 });
    expect(out.output.text).toContain('hi agent');
  });
  it('returns at wait_ms for a program that prints nothing', async () => {
    const t0 = Date.now();
    const quiet = await call(client, 'terminal_start', { command: 'sleep', args: ['30'], wait_ms: 800 });
    expect(quiet).toMatchObject({ kind: 'program', state: 'running', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
    await call(client, 'terminal_kill', { session_id: quiet.session_id });
  });

  it('renders full-screen programs (vim) on the screen view and drives them with keys', async () => {
    const file = path.join(os.tmpdir(), `tmcp-vim-${process.pid}.txt`);
    const vim = await call(client, 'terminal_start', { command: 'vim', args: ['-u', 'NONE', '-N', file], rows: 20, wait_ms: 1500 });
    await call(client, 'terminal_write', { session_id: vim.session_id, input: 'ihello from the agent', keys: ['escape'] });
    const scr = await call(client, 'terminal_read', { session_id: vim.session_id, view: 'screen' });
    expect(scr.screen.alternate_screen).toBe(true);
    expect(scr.screen.text).toContain('hello from the agent');
    const done = await call(client, 'terminal_write', { session_id: vim.session_id, input: ':wq', keys: ['enter'], wait_ms: 3000 });
    expect(done.state).toBe('exited');
    expect(fs.readFileSync(file, 'utf8')).toBe('hello from the agent\n');
    fs.rmSync(file, { force: true });
  });

  it('screen view shows overwritten lines exactly as rendered', async () => {
    const p = await call(client, 'terminal_start', { command: 'bash', args: ['-c', 'printf "\\033[2J\\033[HLINE-A\\nLINE-B\\rOVERWRITE"; sleep 30'] });
    const scr = await call(client, 'terminal_read', { session_id: p.session_id, view: 'screen', wait_ms: 500, wait_for: 'output' });
    expect(scr.screen.text).toContain('LINE-A');
    expect(scr.screen.text).toContain('OVERWRITE');
    expect(scr.screen.text).not.toContain('LINE-B');
    await call(client, 'terminal_kill', { session_id: p.session_id });
  });

  it('bounds memory under an output flood and reports lost output and truncation', async () => {
    const s = await call(client, 'terminal_start', { shell: 'bash' });
    const r = await call(client, 'terminal_exec', { session_id: s.session_id, command: 'seq 1 700000', timeout_ms: 30_000 });
    expect(r.completed).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.output.truncated).toBe(true);
    expect(r.output.text.length).toBeLessThan(17_000);
    expect(r.output.text.trimEnd().endsWith('700000')).toBe(true);
    const old = await call(client, 'terminal_read', { session_id: s.session_id, cursor: 0 });
    expect(old.output_lost).toBe(true);
    expect(old.output.has_more).toBe(true);
    const tail = await call(client, 'terminal_read', { session_id: s.session_id, tail_lines: 3 });
    expect(tail.output.text).toContain('700000');
    await call(client, 'terminal_kill', { session_id: s.session_id });
  });

  it('pages through long output with cursors without gaps or repeats', async () => {
    const s = await call(client, 'terminal_start', { shell: 'bash' });
    const r = await call(client, 'terminal_exec', { session_id: s.session_id, command: 'seq 1 3000', timeout_ms: 10_000 });
    expect(r.completed).toBe(true);
    let cursor = 0;
    const seen: string[] = [];
    for (let i = 0; i < 50; i++) {
      const page = await call(client, 'terminal_read', { session_id: s.session_id, cursor, max_chars: 2000 });
      seen.push(page.output.text);
      cursor = page.next_cursor;
      if (!page.output.has_more) break;
    }
    const numbers = seen.join('\n').split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
    expect(numbers.length).toBe(3000);
    expect(numbers[0]).toBe(1);
    expect(numbers[2999]).toBe(3000);
    await call(client, 'terminal_kill', { session_id: s.session_id });
  });

  it('runs ten sessions concurrently', async () => {
    const sessions = await Promise.all(Array.from({ length: 10 }, () => call(client, 'terminal_start', { shell: 'bash' })));
    const results = await Promise.all(sessions.map((s: Any) => call(client, 'terminal_exec', { session_id: s.session_id, command: 'sleep 0.5; echo $TERMINAL_MCP_SESSION' })));
    results.forEach((r: Any, i: number) => {
      expect(r.exit_code).toBe(0);
      expect(r.output.text).toBe(sessions[i].session_id);
    });
    await Promise.all(sessions.map((s: Any) => call(client, 'terminal_kill', { session_id: s.session_id })));
  });

  it('enforces the session limit with an actionable error', async () => {
    const limited = await stdioClient('legacy', ['--max-sessions', '1']);
    await call(limited, 'terminal_start', { shell: 'bash' });
    const res = await limited.callTool({ name: 'terminal_start', arguments: { shell: 'bash' } });
    expect(res.isError).toBe(true);
    expect((res.content as Any)[0].text).toMatch(/Session limit reached/);
    await limited.close();
  });

  it('finds sessions by name and gives helpful errors for unknown ids', async () => {
    await call(client, 'terminal_start', { shell: 'bash', name: 'devserver' });
    const r = await call(client, 'terminal_exec', { session_id: 'devserver', command: 'echo named' });
    expect(r.output.text).toBe('named');
    const res = await client.callTool({ name: 'terminal_read', arguments: { session_id: 'term_nope' } });
    expect(res.isError).toBe(true);
    expect((res.content as Any)[0].text).toMatch(/Unknown session/);
    await call(client, 'terminal_kill', { session_id: 'devserver' });
  });

  it('returns plain-text output alongside structured content', async () => {
    const s = await call(client, 'terminal_start', { shell: 'bash' });
    const raw = await client.callTool({ name: 'terminal_exec', arguments: { session_id: s.session_id, command: 'echo text-block' } });
    const text = (raw.content as Any)[0].text as string;
    expect(text).toContain('"exit_code": 0');
    expect(text).toContain('--- output ---\ntext-block');
    await call(client, 'terminal_kill', { session_id: s.session_id });
  });
});

describe('lifecycle', () => {
  it('kills every terminal when the stdio client disconnects', async () => {
    const client = await stdioClient('legacy');
    const s = await call(client, 'terminal_start', { shell: 'bash' });
    const r = await call(client, 'terminal_exec', { session_id: s.session_id, command: 'sleep 1000 & echo $!' });
    const child = Number.parseInt(r.output.text.trim().split('\n').pop()!, 10);
    expect(pidAlive(child)).toBe(true);
    expect(pidAlive(s.pid)).toBe(true);
    await client.close();
    for (let i = 0; i < 40 && (pidAlive(child) || pidAlive(s.pid)); i++) await sleep(100);
    expect(pidAlive(s.pid)).toBe(false);
    expect(pidAlive(child)).toBe(false);
  });

  it('kills every terminal on SIGTERM in HTTP mode', async () => {
    const server = await startHttpServer();
    const client = await httpClient(server, 'auto');
    const s = await call(client, 'terminal_start', { shell: 'bash' });
    await client.close();
    await server.stop();
    for (let i = 0; i < 30 && pidAlive(s.pid); i++) await sleep(100);
    expect(pidAlive(s.pid)).toBe(false);
  });
});

describe('HTTP security', () => {
  let server: HttpServer;
  const post = (headers: Record<string, string>) =>
    fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  beforeAll(async () => {
    server = await startHttpServer(['--allowed-host', 'my-tunnel.example.com']);
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('serves an unauthenticated health check', async () => {
    const res = await fetch(new URL('/healthz', server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'terminal-mcp' });
  });

  it('reports the package.json version in health, the MCP handshake and --version', async () => {
    const { version } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(((await (await fetch(new URL('/healthz', server.url))).json()) as Any).version).toBe(version);
    const client = await httpClient(server, 'auto');
    try {
      expect(client.getServerVersion()?.version).toBe(version);
    } finally {
      await client.close();
    }
    const cli = spawn(process.execPath, [CLI, '--version']);
    let out = '';
    cli.stdout.on('data', (d) => (out += d));
    await new Promise((r) => cli.on('close', r));
    expect(out.trim()).toBe(version);
  });

  it('rejects missing and wrong bearer tokens with 401 and a challenge', async () => {
    const missing = await post({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const wrong = await post({ authorization: 'Bearer not-the-token' });
    expect(wrong.status).toBe(401);
  });

  it('rejects foreign browser origins (DNS-rebinding / CSRF protection)', async () => {
    const res = await post({ authorization: `Bearer ${server.token}`, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects unexpected Host headers but accepts the configured tunnel hostname', async () => {
    expect(await rawStatus(server.url, 'attacker.example', server.token)).toBe(403);
    expect(await rawStatus(server.url, 'my-tunnel.example.com', server.token)).toBe(200);
  });

  it('refuses --no-auth on a non-loopback bind', async () => {
    const proc = spawn(process.execPath, [CLI, '--http', '--host', '0.0.0.0', '--no-auth', '--port', '0', '--no-audit'], { stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => proc.on('exit', resolve));
    expect(code).toBe(2);
  });

  it('does not leak the bearer token into terminal environments', async () => {
    const secret = 'env-secret-token-9f8e7d6c5b4a';
    const proc = spawn(process.execPath, [CLI, '--http', '--port', '0', '--no-audit'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TERMINAL_MCP_TOKEN: secret } });
    const url = await new Promise<URL>((resolve) => {
      let buf = '';
      proc.stderr!.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /listening on (http:\/\/\S+\/mcp)/.exec(buf);
        if (m) resolve(new URL(m[1]));
      });
    });
    const c = await httpClient({ url, token: secret, proc, stop: async () => {} }, 'auto');
    const s = await call(c, 'terminal_start', { shell: 'bash' });
    const r = await call(c, 'terminal_exec', { session_id: s.session_id, command: 'env | grep -c env-secret-token || true' });
    expect(r.output.text).toBe('0');
    await c.close();
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
    });
  });

  it('serves URL-only clients on a secret path when --url-token is set, and only then', async () => {
    const urlServer = await startHttpServer(['--url-token']);
    try {
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
      const c = new Client({ name: 'url-only', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${urlServer.url}/${urlServer.token}`)));
      expect((await c.listTools()).tools.length).toBe(6);
      await c.close();
      const wrong = await fetch(`${urlServer.url}/wrong-secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(wrong.status).toBe(404);
    } finally {
      await urlServer.stop();
    }
    const noPath = await fetch(`${server.url}/${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noPath.status).toBe(401);
  });
});

async function rawStatus(url: URL, host: string, token: string): Promise<number> {
  const http = await import('node:http');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
