// Latency + budget check: p50/p95 of a trivial terminal_exec over stdio, and how far tool calls
// overrun their requested wait budgets. Run after `npm run build`: npx tsx test/bench.ts
import { call, stdioClient } from './helpers.js';

const client = await stdioClient('legacy');
const s = await call(client, 'terminal_start', { shell: 'bash' });
for (let i = 0; i < 5; i++) await call(client, 'terminal_exec', { session_id: s.session_id, command: 'true' });

const times: number[] = [];
for (let i = 0; i < 60; i++) {
  const t0 = performance.now();
  await call(client, 'terminal_exec', { session_id: s.session_id, command: `echo ${i}` });
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))].toFixed(1);
console.log(`terminal_exec round trip over stdio (n=${times.length}): p50=${pct(50)}ms p95=${pct(95)}ms max=${times.at(-1)!.toFixed(1)}ms`);

const budgets: Array<[string, Record<string, unknown>, number]> = [
  ['terminal_exec', { session_id: s.session_id, command: 'sleep 5', timeout_ms: 500 }, 500],
  ['terminal_read', { session_id: s.session_id, wait_for: 'command_end', wait_ms: 700 }, 700],
  ['terminal_write', { session_id: s.session_id, input: '', wait_ms: 400, until: 'never-matches' }, 400],
];
for (const [tool, args, budget] of budgets) {
  const t0 = performance.now();
  await call(client, tool, args);
  const took = performance.now() - t0;
  console.log(`${tool} budget ${budget}ms -> returned in ${took.toFixed(0)}ms (overrun ${(took - budget).toFixed(0)}ms)`);
}
await call(client, 'terminal_kill', { session_id: s.session_id });
await client.close();
