// Scripted demo: an MCP client drives terminal-mcp over stdio the way an agent would, and narrates each
// tool call and the server's answer. Every result shown is the server's real response.
//   npm run demo                 # against the local build (dist/cli.js)
//   npm run demo -- --npx        # against the published npm package
//   npm run demo -- --pace 0     # no pauses between steps
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string };
const argv = process.argv.slice(2);
const useNpx = argv.includes('--npx');
const paceAt = argv.indexOf('--pace');
const PACE = paceAt >= 0 ? Number(argv[paceAt + 1]) : 900;
const shellAt = argv.indexOf('--shell');
const SHELL = shellAt >= 0 ? argv[shellAt + 1] : 'auto';

const server = useNpx
  ? { command: 'npx', args: ['-y', pkg.name, '--no-audit'], label: `npx -y ${pkg.name}` }
  : { command: process.execPath, args: [path.join(root, 'dist', 'cli.js'), '--no-audit'], label: 'node dist/cli.js' };

const esc = (code: string) => (s: string | number) => `\x1b[${code}m${s}\x1b[0m`;
const bold = esc('1');
const dim = esc('2');
const cyan = esc('36');
const green = esc('32');
const yellow = esc('1;33');
const magenta = esc('35');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
const client = new Client({ name: 'terminal-mcp-demo', version: '1.0.0' });

function fmtArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  console.log(`  ${cyan('agent →')} ${bold(name)} ${dim(fmtArgs(args))}`);
  calls++;
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent;
}

async function reply(summary: string, output?: string): Promise<void> {
  console.log(`  ${green('server ←')} ${summary}`);
  if (output && output.trim()) {
    const lines = output.replace(/\s+$/, '').split('\n').slice(-8);
    for (const line of lines) console.log(`    ${magenta('│')} ${line}`);
  }
  await sleep(PACE);
}

async function step(title: string): Promise<void> {
  console.log(`\n${yellow('▸ ' + title)}`);
  await sleep(PACE / 3);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'));
fs.mkdirSync(path.join(work, 'app'));
fs.writeFileSync(path.join(work, 'app', 'package.json'), '{}\n');
fs.writeFileSync(path.join(work, 'index.html'), '<h1>hello from terminal-mcp</h1>\n');

try {
  console.log(bold('terminal-mcp demo') + dim(' · an MCP client drives real terminal sessions, as an agent would'));
  await client.connect(
    // Start from a neutral folder: inside this repository, npx would pick the local package instead of the published one.
    new StdioClientTransport({ command: server.command, args: server.args, cwd: work, env: { ...process.env } as Record<string, string>, stderr: 'inherit' }),
  );
  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  console.log(dim(`server: ${server.label} (stdio) · connected to ${info?.name} ${info?.version}`));
  console.log(dim(`tools: ${tools.map((t) => t.name).join(', ')}`));
  await sleep(PACE);

  await step('1. Start a shell session');
  const sh = await call('terminal_start', { name: 'work', shell: SHELL, cwd: work });
  await reply(`ready · ${sh.shell} · command tracking ${sh.integration} · ${sh.shell_state}`);

  await step('2. Run a command: only its output, plus exit code and cwd');
  let r = await call('terminal_exec', { session_id: 'work', command: 'cd app && ls; cat missing.txt' });
  await reply(`exit_code ${bold(r.exit_code)} · cwd ${r.cwd} · ${r.duration_ms} ms`, r.output.text);

  await step('3. A long-running command returns early; keep reading with a cursor');
  r = await call('terminal_exec', { session_id: 'work', command: 'for i in 1 2 3 4 5; do echo "build step $i/5"; sleep 1; done', timeout_ms: 1500 });
  await reply(`completed ${bold(r.completed)} · ${r.shell_state} · cursor ${r.cursor}`, r.output.text);
  const list = await call('terminal_list');
  const w = list.sessions.find((s: { name: string }) => s.name === 'work');
  await reply(`work is ${bold(w.shell_state)}, running for ${w.running_for_ms ?? '?'} ms`);
  const rd = await call('terminal_read', { session_id: 'work', cursor: r.cursor, wait_for: 'command_end' });
  await reply(`finished · exit_code ${bold(rd.last_command.exit_code)} after ${rd.last_command.duration_ms} ms · just the unseen output:`, rd.output.text);

  await step('4. Answer a program that asks a question');
  r = await call('terminal_exec', { session_id: 'work', command: 'read -r -p "Deploy to production? [y/N] " a; echo "answer: $a"', timeout_ms: 1200 });
  await reply(`awaiting_input ${bold(r.awaiting_input)} (${r.input_kind})`, r.output.text.split('\n').pop());
  r = await call('terminal_write', { session_id: 'work', input: 'n\r' });
  await reply(`${r.shell_state} again · exit_code ${r.last_command?.exit_code}`, r.output.text);

  await step('5. Drive a REPL that keeps its state between calls');
  const py = await call('terminal_start', { name: 'py', command: 'python3', args: ['-q'] });
  await reply(`python3 running · awaiting_input ${bold(py.awaiting_input)}`, py.screen);
  await call('terminal_write', { session_id: 'py', input: 'total = sum(range(1, 101))\r' });
  r = await call('terminal_write', { session_id: 'py', input: 'print(total * 2)\r' });
  await reply('the REPL kept `total` from the previous call:', r.output.text);

  await step('6. Keep a server running in one session, use it from another');
  const port = await freePort();
  const web = await call('terminal_start', { name: 'web', command: 'python3', args: ['-m', 'http.server', '-b', '127.0.0.1', String(port)], cwd: work });
  await reply(`${web.state} · pid ${web.pid}`, web.screen);
  r = await call('terminal_exec', { session_id: 'work', command: `curl -s http://127.0.0.1:${port}/index.html` });
  await reply(`exit_code ${r.exit_code}`, r.output.text);
  r = await call('terminal_read', { session_id: 'web', cursor: web.cursor });
  await reply('new server log since start:', r.output.text);

  await step('7. Terminate sessions and check they are gone');
  r = await call('terminal_kill', { session_id: 'web' });
  await reply(`web ${bold(r.state)} (${r.exit_signal}) · whole process tree stopped`);
  r = await call('terminal_exec', { session_id: 'work', command: `curl -s --max-time 2 http://127.0.0.1:${port}/; echo "curl exit $?"` });
  await reply('port is closed:', r.output.text);
  await call('terminal_kill', { session_id: 'py' });
  await call('terminal_kill', { session_id: 'work' });
  const end = await call('terminal_list');
  await reply(end.sessions.map((s: { name: string; state: string }) => `${s.name} ${s.state}`).join(' · '));

  console.log(`\n${bold('Done.')} ${dim(`3 sessions, ${calls} tool calls, all through MCP.`)}`);
} catch (err) {
  console.error(`\ndemo failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
