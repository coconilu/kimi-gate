/**
 * Sliding-window rate limiter persisted in SQLite (survives restarts).
 * Window events are rows in rl_events; allowance = count within window < limit.
 */
import type { Db } from './db.js';

export interface RateLimiterOptions {
  limit: number;        // max events per window
  windowMs: number;     // window size
  now?: () => number;   // injectable clock for tests
}

export class RateLimiter {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly opts: RateLimiterOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Record an attempt; returns true if allowed, false if over the limit. */
  allow(device: string): boolean {
    const now = this.now();
    const cutoff = now - this.opts.windowMs;
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM rl_events WHERE device = ? AND ts > ?')
      .get(device, cutoff) as { n: number };
    const allowed = row.n < this.opts.limit;
    this.db.prepare('INSERT INTO rl_events (device, ts) VALUES (?, ?)').run(device, now);
    // opportunistic cleanup of expired rows for this device
    this.db.prepare('DELETE FROM rl_events WHERE device = ? AND ts <= ?').run(device, cutoff);
    return allowed;
  }

  /** Current count within the window (for observability/tests). */
  count(device: string): number {
    const cutoff = this.now() - this.opts.windowMs;
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM rl_events WHERE device = ? AND ts > ?')
      .get(device, cutoff) as { n: number };
    return row.n;
  }
}
