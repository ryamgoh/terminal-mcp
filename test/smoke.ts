// Narrated local check: launches the built server over stdio, the way Claude Code or Cursor do, and drives
// one terminal session through the main features. Usage: npm run smoke [-- --shell bash|zsh]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? process.argv[shellArg + 1] : 'auto';

const client = new Client({ name: 'terminal-mcp-smoke', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [CLI, '--no-audit'], env: { ...process.env } as Record<string, string>, stderr: 'inherit' }),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent;
}

let step = 0;
let failures = 0;
function report(title: string, ok: boolean, detail: string): void {
  step++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}. ${title}\n      ${detail.replace(/\n/g, '\n      ')}`);
}

try {
  const { tools } = await client.listTools();
  report('Server answers over stdio and lists its tools', tools.length === 6, tools.map((t) => t.name).join(', '));

  const s = await call('terminal_start', { shell });
  const id = s.session_id;
  report('Start a tracked shell', s.integration === 'vscode-osc633' && s.shell_state === 'idle', `${s.shell} in ${s.cwd}, command tracking: ${s.integration}`);

  let r = await call('terminal_exec', { session_id: id, command: 'echo "hello from $0"; uname -sm' });
  report('Run a command and get only its output', r.completed && r.exit_code === 0, r.output.text);

  r = await call('terminal_exec', { session_id: id, command: 'cd /tmp && export SMOKE=kept' });
  const r2 = await call('terminal_exec', { session_id: id, command: 'echo "$PWD $SMOKE"' });
  report('Shell state persists between calls', r2.output.text.endsWith('kept') && r.cwd === r2.cwd, `cwd ${r2.cwd}, output "${r2.output.text}"`);

  r = await call('terminal_exec', { session_id: id, command: 'ls /definitely-not-here' });
  report('Failures come back with their exit code', r.completed && r.exit_code !== 0, `exit_code ${r.exit_code}: ${r.output.text}`);

  r = await call('terminal_exec', { session_id: id, command: "cat <<'EOF'\nmulti-line\nheredoc\nEOF" });
  report('Multi-line commands and heredocs', r.output.text === 'multi-line\nheredoc', r.output.text);

  r = await call('terminal_exec', { session_id: id, command: 'for i in 1 2 3; do echo tick $i; sleep 1; done', timeout_ms: 1200 });
  const early = !r.completed;
  const rest = await call('terminal_read', { session_id: id, cursor: r.cursor, wait_for: 'command_end', timeout_ms: 10000 });
  report('Long command returns early, then the agent waits for the end', early && rest.reason === 'command_finished' && rest.last_command?.exit_code === 0, `first call returned with completed=${r.completed}; follow-up read: reason=${rest.reason}, exit_code=${rest.last_command?.exit_code}`);

  r = await call('terminal_exec', { session_id: id, command: 'printf "Your name? "; read n; echo "hi $n"', timeout_ms: 800 });
  const waiting = r.awaiting_input === true;
  const w = await call('terminal_write', { session_id: id, input: 'Ada\r', until: 'hi Ada' });
  report('Interactive input: detect the prompt, answer it', waiting && w.output.text.includes('hi Ada'), `awaiting_input=${r.awaiting_input} (${r.input_kind}); after answering: "${w.output.text.split('\n').find((l: string) => l.includes('hi Ada'))}"`);

  r = await call('terminal_exec', { session_id: id, command: 'sleep 30', timeout_ms: 300 });
  const c = await call('terminal_write', { session_id: id, keys: ['ctrl+c'] });
  const after = await call('terminal_read', { session_id: id, wait_for: 'command_end', timeout_ms: 3000 });
  report('Ctrl+C interrupts a running command', after.shell_state === 'idle' && after.last_command?.exit_code === 130, `shell_state=${after.shell_state}, exit_code=${after.last_command?.exit_code} (${c.reason})`);

  const list = await call('terminal_list', {});
  report('List sessions with their state', list.sessions.some((x: { session_id: string }) => x.session_id === id), list.sessions.map((x: { session_id: string; state: string; shell_state: string; cwd: string }) => `${x.session_id} ${x.state}/${x.shell_state} ${x.cwd}`).join('\n'));

  const k = await call('terminal_kill', { session_id: id });
  report('Kill the session and its process tree', k.state === 'exited', `state=${k.state}, signal=${k.signal ?? 'none'}`);
} catch (err) {
  failures++;
  console.log(`FAIL  ${(err as Error).message}`);
} finally {
  await client.close();
}

console.log(failures ? `\n${failures} check(s) failed.` : `\nAll ${step} checks passed.`);
process.exit(failures ? 1 : 0);
