/**
 * Client-side rate limiting for the (free) Datamuse API.
 *
 * Three independent guards, all must pass before a request is sent:
 *  - burst:   token bucket, `perMinute` requests per rolling minute
 *  - daily:   hard cap per UTC day, persisted so it survives worker restarts
 *  - breaker: after 429 / repeated failures, back off exponentially
 *
 * Pure logic with injectable clock + persistence so it's unit-testable.
 */

export interface RateLimitOptions {
  perMinute: number;
  perDay: number;
  maxConcurrent: number;
  /** base cooldown after a failure, doubled per consecutive failure */
  cooldownMs: number;
  maxCooldownMs: number;
  now?: () => number;
  load?: () => Promise<DailyBudget | undefined>;
  save?: (b: DailyBudget) => Promise<void>;
}

export interface DailyBudget {
  day: string; // YYYY-MM-DD (UTC)
  count: number;
}

export type Denial = 'burst' | 'daily' | 'cooldown' | 'concurrency';

export const DATAMUSE_LIMITS: Omit<RateLimitOptions, 'now' | 'load' | 'save'> = {
  perMinute: 20,
  perDay: 1000, // Datamuse allows 100k/day; stay two orders of magnitude under it
  maxConcurrent: 3,
  cooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
};

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private inflight = 0;
  private failures = 0;
  private cooldownUntil = 0;
  private budget: DailyBudget | null = null;
  private loading: Promise<void> | null = null;
  private readonly opts: Required<Pick<RateLimitOptions, 'perMinute' | 'perDay' | 'maxConcurrent' | 'cooldownMs' | 'maxCooldownMs'>>;
  private readonly now: () => number;
  private readonly load: () => Promise<DailyBudget | undefined>;
  private readonly save: (b: DailyBudget) => Promise<void>;

  constructor(o: RateLimitOptions) {
    this.opts = o;
    this.now = o.now ?? (() => Date.now());
    this.load = o.load ?? (async () => undefined);
    this.save = o.save ?? (async () => {});
    this.tokens = o.perMinute;
    this.lastRefill = this.now();
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private async ensureBudget(): Promise<DailyBudget> {
    if (!this.budget) {
      this.loading ??= this.load().then((b) => {
        this.budget = b && b.day === this.today() ? b : { day: this.today(), count: 0 };
      });
      await this.loading;
    }
    if (this.budget!.day !== this.today()) this.budget = { day: this.today(), count: 0 };
    return this.budget!;
  }

  private refill() {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.opts.perMinute, this.tokens + (elapsed / 60_000) * this.opts.perMinute);
    this.lastRefill = t;
  }

  /** Why a request would be denied right now, or null if allowed. */
  async check(): Promise<Denial | null> {
    if (this.now() < this.cooldownUntil) return 'cooldown';
    if (this.inflight >= this.opts.maxConcurrent) return 'concurrency';
    this.refill();
    if (this.tokens < 1) return 'burst';
    const b = await this.ensureBudget();
    if (b.count >= this.opts.perDay) return 'daily';
    return null;
  }

  /** Reserve a slot. Returns a denial reason, or a release function. */
  async acquire(): Promise<{ denied: Denial } | { release: (outcome: 'ok' | 'fail' | 'ratelimited', retryAfterMs?: number) => void }> {
    const denied = await this.check();
    if (denied) return { denied };
    this.tokens -= 1;
    this.inflight += 1;
    const b = await this.ensureBudget();
    b.count += 1;
    void this.save(b).catch(() => {});
    let released = false;
    return {
      release: (outcome, retryAfterMs) => {
        if (released) return;
        released = true;
        this.inflight -= 1;
        if (outcome === 'ok') {
          this.failures = 0;
          return;
        }
        this.failures += 1;
        const backoff = Math.min(this.opts.maxCooldownMs, this.opts.cooldownMs * 2 ** (this.failures - 1));
        const wait = outcome === 'ratelimited' ? Math.max(backoff, retryAfterMs ?? 60_000) : backoff;
        this.cooldownUntil = this.now() + wait;
      },
    };
  }

  /** Snapshot for the UI. */
  async status(): Promise<{ denied: Denial | null; usedToday: number; perDay: number }> {
    const denied = await this.check();
    const b = await this.ensureBudget();
    return { denied, usedToday: b.count, perDay: this.opts.perDay };
  }
}
