import type { Limits, SessionDefaults } from '../config.js';
import { Session, type StartOptions } from './session.js';

/**
 * Process-wide registry. MCP server instances are created per connection (stdio) or per request
 * (stateless Streamable HTTP), so terminal state must live here, not inside an McpServer.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly reaper: NodeJS.Timeout;

  constructor(
    readonly limits: Limits,
    readonly defaults: SessionDefaults,
  ) {
    this.reaper = setInterval(() => void this.reap(), 15_000);
    this.reaper.unref();
  }

  start(opts: StartOptions): Session {
    const running = this.list().filter((s) => s.state === 'running');
    if (running.length >= this.limits.maxSessions) {
      throw new Error(`Session limit reached (${this.limits.maxSessions} running). Kill sessions you no longer need with terminal_kill (see terminal_list).`);
    }
    if (opts.name) {
      const clash = running.find((s) => s.name === opts.name);
      if (clash) throw new Error(`A running session is already named "${opts.name}" (${clash.id}). Pick another name or reuse that session.`);
    }
    const session = new Session(opts, this.limits, this.defaults);
    this.sessions.set(session.id, session);
    return session;
  }

  /** Look up by session_id, or by name (newest running session with that name wins). */
  get(ref: string): Session {
    const direct = this.sessions.get(ref);
    if (direct) return direct;
    const named = this.list()
      .filter((s) => s.name === ref)
      .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.createdAt - a.createdAt)[0];
    if (named) return named;
    const known = this.list().map((s) => (s.name ? `${s.id} (${s.name})` : s.id));
    throw new Error(`Unknown session "${ref}". ${known.length ? `Known sessions: ${known.join(', ')}.` : 'No sessions exist; create one with terminal_start.'}`);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const s of this.list()) {
      if (s.state === 'exited' && s.exitedAt && now - s.exitedAt > this.limits.exitedTtlMs) {
        s.dispose();
        this.sessions.delete(s.id);
      } else if (s.state === 'running' && this.limits.idleTimeoutMs > 0 && now - s.lastTouchedAt > this.limits.idleTimeoutMs) {
        await s.kill('SIGHUP', 2000);
      }
    }
  }

  /** Graceful shutdown: hang up every session (like closing terminal windows), then SIGKILL stragglers. */
  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.allSettled(this.list().map((s) => s.kill('SIGHUP', 1500)));
  }

  /** Synchronous backstop used from process 'exit'. */
  killAllNow(): void {
    for (const s of this.list()) s.killNow();
  }
}
