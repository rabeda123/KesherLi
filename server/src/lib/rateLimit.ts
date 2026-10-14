import { tooMany } from './errors.js';

/**
 * Fixed-window counters kept in memory. Good for a single instance; when
 * running several instances, replace with a shared store (e.g. Redis) behind
 * the same interface.
 */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  /** Counts one hit for key and throws 429 when more than max hits fall within windowMs. */
  consume(key: string, max: number, windowMs: number): void {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) throw tooMany();
    if (this.buckets.size > 50_000) this.sweep(now);
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}
