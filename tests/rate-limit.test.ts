import { describe, it, expect } from 'vitest';
import { RateLimiter, type DailyBudget } from '../src/synonyms/rate-limit';
import { isSafeTerm } from '../src/synonyms/service';
import { sanitizeTerms, LIMITS } from '../src/messages';

function make(over: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) {
  let t = Date.UTC(2026, 0, 1, 12, 0, 0);
  let saved: DailyBudget | undefined;
  const rl = new RateLimiter({
    perMinute: 3,
    perDay: 5,
    maxConcurrent: 2,
    cooldownMs: 1000,
    maxCooldownMs: 8000,
    now: () => t,
    load: async () => saved,
    save: async (b) => {
      saved = { ...b };
    },
    ...over,
  });
  return { rl, tick: (ms: number) => (t += ms), getSaved: () => saved };
}

async function take(rl: RateLimiter) {
  const r = await rl.acquire();
  if ('denied' in r) return r.denied;
  return r.release;
}

describe('RateLimiter', () => {
  it('enforces the per-minute burst and refills over time', async () => {
    const { rl, tick } = make();
    for (let i = 0; i < 3; i++) {
      const r = await take(rl);
      expect(typeof r).toBe('function');
      (r as (o: 'ok') => void)('ok');
    }
    expect(await take(rl)).toBe('burst');
    tick(20_000); // 1/3 of a minute → 1 token back
    expect(typeof (await take(rl))).toBe('function');
  });

  it('enforces the daily cap, persists it, and resets at UTC midnight', async () => {
    const { rl, tick, getSaved } = make({ perMinute: 100 });
    for (let i = 0; i < 5; i++) ((await take(rl)) as (o: 'ok') => void)('ok');
    expect(await take(rl)).toBe('daily');
    expect(getSaved()?.count).toBe(5);
    tick(13 * 60 * 60 * 1000); // past midnight UTC
    expect(typeof (await take(rl))).toBe('function');
  });

  it('caps concurrency', async () => {
    const { rl } = make({ perMinute: 100 });
    const a = (await take(rl)) as (o: 'ok') => void;
    const b = (await take(rl)) as (o: 'ok') => void;
    expect(await take(rl)).toBe('concurrency');
    a('ok');
    expect(typeof (await take(rl))).toBe('function');
    b('ok');
  });

  it('backs off exponentially after failures and honours Retry-After on 429', async () => {
    const { rl, tick } = make({ perMinute: 100, perDay: 100 });
    ((await take(rl)) as (o: 'fail') => void)('fail');
    expect(await take(rl)).toBe('cooldown');
    tick(1001);
    ((await take(rl)) as (o: 'fail') => void)('fail'); // second failure → 2s
    tick(1500);
    expect(await take(rl)).toBe('cooldown');
    tick(600);
    const rel = (await take(rl)) as (o: 'ratelimited', ms: number) => void;
    rel('ratelimited', 5000); // max(backoff 4s, retry-after 5s) = 5s
    tick(4500);
    expect(await take(rl)).toBe('cooldown');
    tick(600);
    ((await take(rl)) as (o: 'ok') => void)('ok'); // success resets failure streak
    ((await take(rl)) as (o: 'fail') => void)('fail');
    tick(1001);
    expect(typeof (await take(rl))).toBe('function');
  });
});

describe('term hygiene', () => {
  it('only lets dictionary-looking words reach the network', () => {
    expect(isSafeTerm('fast')).toBe(true);
    expect(isSafeTerm("rock 'n' roll")).toBe(true);
    expect(isSafeTerm('well-being')).toBe(true);
    expect(isSafeTerm('café')).toBe(true);
    expect(isSafeTerm('a')).toBe(false);
    expect(isSafeTerm('john.doe@example.com')).toBe(false);
    expect(isSafeTerm('4111 1111 1111 1111')).toBe(false);
    expect(isSafeTerm('https://example.com')).toBe(false);
    expect(isSafeTerm('one two three four')).toBe(false);
    expect(isSafeTerm('x'.repeat(41))).toBe(false);
    expect(isSafeTerm('sk-abc123')).toBe(false);
  });

  it('sanitizeTerms caps count and length and rejects non-strings', () => {
    expect(sanitizeTerms(null)).toBeNull();
    expect(sanitizeTerms(['a', 1])).toBeNull();
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    expect(sanitizeTerms(many)).toHaveLength(LIMITS.maxTerms);
    expect(sanitizeTerms(['x'.repeat(200)])![0]).toHaveLength(LIMITS.maxTermLength);
    expect(sanitizeTerms(['  ', 'ok'])).toEqual(['ok']);
  });
});
