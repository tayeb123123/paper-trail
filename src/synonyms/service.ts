/**
 * Synonym lookup, runs in the background service worker.
 *
 *  1. offline table bundled with the extension (WordNet + Moby, free)
 *  2. optional top-up from Datamuse (free, no key), cached, rate limited
 *
 * Discretion rules for the network path:
 *  - only runs when the user has switched "online thesaurus" on
 *  - only plain dictionary-looking words are ever sent (see isSafeTerm);
 *    anything with digits, symbols, @, URLs, or long strings stays local
 *  - page content is never sent — only the words the user typed
 */
import { STORAGE_KEYS } from '../messages';
import { RateLimiter, DATAMUSE_LIMITS, type Denial, type DailyBudget } from './rate-limit';

type Table = Record<string, string[]>;
interface CacheEntry {
  w: string[];
  t: number; // stored at (ms)
}
type Cache = Record<string, CacheEntry>;

export interface LookupResult {
  result: Table;
  /** why the online path was skipped for at least one term, if it was */
  online: { used: boolean; denied: Denial | null; usedToday: number; perDay: number };
}

const MAX_ONLINE = 8;
const MAX_RESULTS = 12;
const ONLINE_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1500;

// ------------------------------------------------------------- offline table
let table: Table | null = null;
let loading: Promise<Table> | null = null;

async function loadTable(): Promise<Table> {
  if (table) return table;
  loading ??= fetch(chrome.runtime.getURL('thesaurus.json'))
    .then((r) => r.json() as Promise<Table>)
    .then((t) => (table = t));
  return loading;
}

// -------------------------------------------------------------- term hygiene
/**
 * A term is safe to send to a third party only if it looks like an ordinary
 * word or short phrase: letters (any script), apostrophes, hyphens, spaces.
 * 2–40 chars, at most 3 words. No digits, no punctuation, no URLs/emails.
 */
export function isSafeTerm(term: string): boolean {
  const t = term.trim();
  if (t.length < 2 || t.length > 40) return false;
  if (!/^[\p{L}'’-]+(?: [\p{L}'’-]+){0,2}$/u.test(t)) return false;
  return /\p{L}/u.test(t);
}

// ---------------------------------------------------------- rate limiting
const limiter = new RateLimiter({
  ...DATAMUSE_LIMITS,
  load: async () => {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.apiBudget);
      return got[STORAGE_KEYS.apiBudget] as DailyBudget | undefined;
    } catch {
      return undefined;
    }
  },
  save: async (b) => {
    await chrome.storage.local.set({ [STORAGE_KEYS.apiBudget]: b });
  },
});

// -------------------------------------------------------------- online cache
const memCache = new Map<string, string[]>();
const inflight = new Map<string, Promise<string[] | null>>();
let diskCache: Cache | null = null;
let diskCacheLoading: Promise<Cache> | null = null;

function loadCache(): Promise<Cache> {
  if (diskCache) return Promise.resolve(diskCache);
  // memoized so parallel lookups share one object instead of racing
  diskCacheLoading ??= (async () => {
    const out: Cache = {};
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.onlineCache);
      const raw = (got[STORAGE_KEYS.onlineCache] as Cache | undefined) ?? {};
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (v && Array.isArray(v.w) && typeof v.t === 'number' && now - v.t < CACHE_TTL_MS) out[k] = v;
      }
    } catch {
      /* start empty */
    }
    diskCache = out;
    return out;
  })();
  return diskCacheLoading;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistCache() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!diskCache) return;
    const entries = Object.entries(diskCache);
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => a[1].t - b[1].t);
      for (const [k] of entries.slice(0, entries.length - CACHE_MAX_ENTRIES)) delete diskCache[k];
    }
    chrome.storage.local.set({ [STORAGE_KEYS.onlineCache]: diskCache }).catch(() => {});
  }, 500);
}

/** null = skipped (rate limited / unsafe / offline); [] = looked up, nothing found */
async function online(term: string): Promise<string[] | null> {
  if (!isSafeTerm(term)) return null;
  const hit = memCache.get(term);
  if (hit) return hit;
  const cache = await loadCache();
  const c = cache[term];
  if (c) {
    memCache.set(term, c.w);
    return c.w;
  }
  const pending = inflight.get(term);
  if (pending) return pending;

  const p = (async (): Promise<string[] | null> => {
    const slot = await limiter.acquire();
    if ('denied' in slot) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ONLINE_TIMEOUT_MS);
    try {
      const url = `https://api.datamuse.com/words?rel_syn=${encodeURIComponent(term)}&max=${MAX_ONLINE}`;
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        slot.release('ratelimited', Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        return null;
      }
      if (!res.ok) {
        slot.release('fail');
        return null;
      }
      const data = (await res.json()) as unknown;
      const words = Array.isArray(data)
        ? data
            .map((d) => (d && typeof d === 'object' && typeof (d as { word?: unknown }).word === 'string' ? (d as { word: string }).word : ''))
            .filter((w) => w && isSafeTerm(w))
            .slice(0, MAX_ONLINE)
        : [];
      slot.release('ok');
      memCache.set(term, words);
      cache[term] = { w: words, t: Date.now() };
      persistCache();
      return words;
    } catch {
      slot.release('fail'); // network error / timeout
      return null;
    } finally {
      clearTimeout(timer);
      inflight.delete(term);
    }
  })();
  inflight.set(term, p);
  return p;
}

// ------------------------------------------------------------------- lookup
export async function lookup(terms: string[], useOnline: boolean): Promise<LookupResult> {
  const t = await loadTable();
  const result: Table = {};
  let onlineUsed = false;

  await Promise.all(
    terms.map(async (raw) => {
      const term = raw.trim().toLowerCase();
      if (!term) return;
      const clean = (s: string) => s.trim().toLowerCase();
      const offline = (t[term] ?? []).map(clean);
      let web: string[] = [];
      if (useOnline) {
        const w = await online(term);
        if (w) {
          web = w.map(clean);
          onlineUsed = true;
        }
      }
      // Words both sources agree on come first, then offline (frequency
      // ranked), then Datamuse-only. Both sources are noisy in different ways.
      const score = new Map<string, number>();
      offline.forEach((w, i) => score.set(w, (score.get(w) ?? 0) + 100 - i));
      web.forEach((w, i) => score.set(w, (score.get(w) ?? 0) + 100 - i));
      const both = new Set(offline.filter((w) => web.includes(w)));
      result[raw] = [...score.keys()]
        .filter((w) => w && w !== term)
        .sort((a, b) => Number(both.has(b)) - Number(both.has(a)) || score.get(b)! - score.get(a)!)
        .slice(0, MAX_RESULTS);
    }),
  );

  const st = await limiter.status();
  return { result, online: { used: onlineUsed, denied: useOnline ? st.denied : null, usedToday: st.usedToday, perDay: st.perDay } };
}
