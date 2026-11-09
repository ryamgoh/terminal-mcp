import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');
export type Era = 'legacy' | 'auto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${(res.content as Any)[0]?.text}`);
  return res.structuredContent;
}

export async function callRaw(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Any> {
  return client.callTool({ name, arguments: args });
}

function newClient(era: Era): Client {
  return new Client({ name: 'terminal-mcp-tests', version: '1.0.0' }, era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : undefined);
}

export async function stdioClient(era: Era, extraArgs: string[] = []): Promise<Client> {
  const client = newClient(era);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--no-audit', ...extraArgs], env, stderr: 'ignore' }));
  return client;
}

export interface HttpServer {
  url: URL;
  token: string;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

export async function startHttpServer(extraArgs: string[] = [], token = 'test-token-0123456789abcdef'): Promise<HttpServer> {
  const proc = spawn(process.execPath, [CLI, '--http', '--port', '0', '--no-audit', '--token', token, ...extraArgs], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env },
  });
  const url = await new Promise<URL>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 10_000);
    proc.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /listening on (http:\/\/\S+\/mcp)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(new URL(m[1]));
      }
    });
    proc.on('exit', (code) => reject(new Error(`server exited early (${code}): ${buf}`)));
  });
  return {
    url,
    token,
    proc,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}

export async function httpClient(server: HttpServer, era: Era): Promise<Client> {
  const client = newClient(era);
  await client.connect(new StreamableHTTPClientTransport(server.url, { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
  return client;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
