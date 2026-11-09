import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { call, httpClient, pidAlive, sleep, startHttpServer, stdioClient, type Any, type Era, type HttpServer } from './helpers.js';

const combos: Array<{ transport: 'stdio' | 'http'; era: Era; shell: 'bash' | 'zsh' }> = [
  { transport: 'stdio', era: 'legacy', shell: 'bash' },
  { transport: 'stdio', era: 'legacy', shell: 'zsh' },
  { transport: 'http', era: 'auto', shell: 'zsh' },
  { transport: 'http', era: 'auto', shell: 'bash' },
];

describe.each(combos)('shell sessions over $transport ($era client, $shell)', ({ transport, era, shell }) => {
  let client: Client;
  let server: HttpServer | undefined;
  let id: string;

  beforeAll(async () => {
    if (transport === 'http') {
      server = await startHttpServer();
      client = await httpClient(server, era);
    } else {
      client = await stdioClient(era);
    }
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it('exposes exactly the six terminal tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['terminal_exec', 'terminal_kill', 'terminal_list', 'terminal_read', 'terminal_start', 'terminal_write']);
  });

  it('starts a tracked shell that reaches an idle prompt', async () => {
    const s = await call(client, 'terminal_start', { shell, cwd: '/' });
    id = s.session_id;
    expect(s).toMatchObject({ state: 'running', kind: 'shell', shell, integration: 'vscode-osc633', shell_state: 'idle', reason: 'ready' });
  });

  it('runs a command and returns only its output with exit code 0', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'echo hello-$((6*7))' });
    expect(r).toMatchObject({ completed: true, exit_code: 0 });
    expect(r.output.text).toBe('hello-42');
  });

  it('reports non-zero exit codes', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'ls /definitely-missing-dir' });
    expect(r.completed).toBe(true);
    expect(r.exit_code).not.toBe(0);
    expect(r.output.text).toMatch(/No such file or directory/);
  });

  it('keeps shell state (cwd, env) between calls and tracks cwd', async () => {
    await call(client, 'terminal_exec', { session_id: id, command: 'cd /tmp && export FOO=bar' });
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'echo "$PWD:$FOO"' });
    expect(r.output.text).toBe('/tmp:bar');
    expect(r.cwd).toBe('/tmp');
  });

  it('reports the new cwd from the same command that changed it', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'cd / && echo moved' });
    expect(r.output.text).toBe('moved');
    expect(r.cwd).toBe('/');
    const back = await call(client, 'terminal_exec', { session_id: id, command: 'cd /tmp' });
    expect(back.cwd).toBe('/tmp');
  });

  it('renders carriage-return progress output the way a terminal shows it', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: "printf '10%%\\r50%%\\r100%%\\n'" });
    expect(r.output.text).toBe('100%');
  });

  it('keeps agent commands out of shell history', async () => {
    const tag = `hm${Math.random().toString(36).slice(2, 10)}`;
    await call(client, 'terminal_exec', { session_id: id, command: `echo ${tag}-single` });
    await call(client, 'terminal_exec', { session_id: id, command: `echo ${tag}-first\necho ${tag}-second` });
    const h = await call(client, 'terminal_exec', { session_id: id, command: 'fc -l -50 2>/dev/null | cat' });
    expect(h.output.text).not.toContain(tag);
  });

  it('runs a multi-line command via bracketed paste', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'echo line-one\necho line-two' });
    expect(r.completed).toBe(true);
    expect(r.output.text).toContain('line-one');
    expect(r.output.text).toContain('line-two');
  });

  it('writes a file with a multi-line heredoc containing quotes, tabs and backslashes', async () => {
    const file = `/tmp/tmcp-heredoc-${Math.random().toString(36).slice(2, 8)}.txt`;
    const body = "it's \"quoted\"\n\tindented\\back $HOME";
    const command = `cat > ${file} <<'EOF'\n${body}\nEOF\nwc -l < ${file}`;
    const r = await call(client, 'terminal_exec', { session_id: id, command });
    expect(r.completed).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.command).toBe(command);
    expect(r.output.text.trim()).toBe('2');
    const back = await call(client, 'terminal_exec', { session_id: id, command: `cat ${file}; rm -f ${file}` });
    // The terminal renders the tab as a move to the next tab stop (column 8).
    expect(back.output.text).toBe(body.replace('\t', ' '.repeat(8)));
  });

  it('returns early from a long command and lets the agent wait for its end', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'for i in 1 2 3; do echo tick$i; sleep 0.5; done; echo finished', timeout_ms: 400 });
    expect(r).toMatchObject({ completed: false, reason: 'timeout', shell_state: 'busy' });
    const done = await call(client, 'terminal_read', { session_id: id, cursor: r.cursor, wait_for: 'command_end', wait_ms: 10_000 });
    expect(done.reason).toBe('command_finished');
    expect(done.last_command.exit_code).toBe(0);
    expect(done.last_command.output.text).toContain('finished');
    expect(done.shell_state).toBe('idle');
  });

  it('streams output with cursors and regex waits', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'sleep 0.3; echo marker-alpha; sleep 0.3; echo marker-beta', timeout_ms: 100 });
    const a = await call(client, 'terminal_read', { session_id: id, cursor: r.cursor, until: 'marker-alpha', wait_ms: 5000 });
    expect(a.reason).toBe('matched');
    const b = await call(client, 'terminal_read', { session_id: id, cursor: a.next_cursor, until: 'marker-beta', wait_ms: 5000 });
    expect(b.reason).toBe('matched');
    expect(b.output.text).toContain('marker-beta');
    expect(b.output.text).not.toContain('marker-alpha');
    await call(client, 'terminal_read', { session_id: id, wait_for: 'command_end', wait_ms: 5000 });
  });

  it('interrupts a running command with ctrl+c (exit 130) and keeps the shell', async () => {
    await call(client, 'terminal_exec', { session_id: id, command: 'sleep 300', timeout_ms: 300 });
    await call(client, 'terminal_write', { session_id: id, keys: ['ctrl+c'] });
    const r = await call(client, 'terminal_read', { session_id: id, wait_for: 'command_end', wait_ms: 5000 });
    expect(r.shell_state).toBe('idle');
    expect(r.last_command.exit_code).toBe(130);
  });

  it('detects a password prompt (echo off) and accepts the answer', async () => {
    const r = await call(client, 'terminal_exec', {
      session_id: id,
      command: `python3 -c "import getpass; p = getpass.getpass('Password: '); print('got', len(p), 'chars')"`,
      timeout_ms: 1500,
    });
    expect(r).toMatchObject({ completed: false, awaiting_input: true, input_kind: 'password' });
    await call(client, 'terminal_write', { session_id: id, input: 's3cret', keys: ['enter'] });
    const done = await call(client, 'terminal_read', { session_id: id, wait_for: 'command_end', wait_ms: 5000 });
    expect(done.last_command.exit_code).toBe(0);
    expect(done.last_command.output.text).toContain('got 6 chars');
    expect(done.last_command.output.text).not.toContain('s3cret');
  });

  it('refuses a second command while one is running, with guidance', async () => {
    await call(client, 'terminal_exec', { session_id: id, command: 'sleep 2', timeout_ms: 100 });
    const res = await client.callTool({ name: 'terminal_exec', arguments: { session_id: id, command: 'echo nope' } });
    expect(res.isError).toBe(true);
    expect((res.content as Any)[0].text).toMatch(/still running/);
    await call(client, 'terminal_read', { session_id: id, wait_for: 'command_end', wait_ms: 5000 });
  });

  it('kills the whole process tree, including background jobs', async () => {
    const r = await call(client, 'terminal_exec', { session_id: id, command: 'sleep 1000 & echo $!' });
    const child = Number.parseInt(r.output.text.trim().split('\n').pop()!, 10);
    expect(pidAlive(child)).toBe(true);
    const k = await call(client, 'terminal_kill', { session_id: id });
    expect(k.state).toBe('exited');
    await sleep(300);
    expect(pidAlive(child)).toBe(false);
  });

  it('reports the shell exit code when the shell itself exits', async () => {
    const s = await call(client, 'terminal_start', { shell });
    const r = await call(client, 'terminal_exec', { session_id: s.session_id, command: 'exit 3', timeout_ms: 5000 });
    expect(r).toMatchObject({ completed: true, reason: 'exited', state: 'exited', exit_code: 3 });
    const list = await call(client, 'terminal_list');
    expect(list.sessions.find((x: Any) => x.session_id === s.session_id)).toMatchObject({ state: 'exited', exit_code: 3 });
  });
});
