// Remote check: drive the server through its public HTTPS URL like a hosted MCP client (e.g. Manus)
// would after you expose it with a tunnel. Usage: npx tsx test/remote-check.ts <url> <token>
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { call } from './helpers.js';

const [url, token] = process.argv.slice(2);
for (const era of ['legacy', 'auto'] as const) {
  const client = new Client({ name: `remote-${era}`, version: '1' }, era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : undefined);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const s = await call(client, 'terminal_start', { shell: 'bash', name: `remote-${era}` });
  const r = await call(client, 'terminal_exec', { session_id: s.session_id, command: 'cd /tmp && echo "hi from $(hostname) in $PWD"' });
  const long = await call(client, 'terminal_exec', { session_id: s.session_id, command: 'sleep 1; echo slow-done', timeout_ms: 200 });
  const done = await call(client, 'terminal_read', { session_id: s.session_id, cursor: long.cursor, wait_for: 'command_end', wait_ms: 5000 });
  const k = await call(client, 'terminal_kill', { session_id: s.session_id });
  const negotiated = (client as unknown as { getNegotiatedProtocolVersion?: () => string }).getNegotiatedProtocolVersion?.() ?? 'n/a';
  console.log(
    `[${era} client, protocol ${negotiated}] start=${s.shell_state} exec="${r.output.text}" exit=${r.exit_code} cwd=${r.cwd} | ` +
      `long: completed=${long.completed} -> ${done.reason} "${done.last_command.output.text}" | kill -> ${k.state}`,
  );
  await client.close();
}
