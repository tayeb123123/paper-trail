/** Messages between background ↔ content script. */

export interface Settings {
  wholeWord: boolean;
  variants: boolean;
  synonyms: boolean;
  /**
   * Free Datamuse API (WordNet-backed) to top up the offline thesaurus.
   * Off by default: turning it on is the user's consent to send typed words.
   */
  online: boolean;
  clusterWindow: number;
  clusterMinDistinct: number;
}

export const DEFAULT_SETTINGS: Settings = {
  wholeWord: true,
  variants: true,
  synonyms: true,
  online: false,
  clusterWindow: 160,
  clusterMinDistinct: 2,
};

/** Hard caps enforced on both sides of the message boundary. */
export const LIMITS = {
  maxTerms: 20,
  maxTermLength: 64,
  maxCustomPerTerm: 20,
} as const;

export type BgRequest = { type: 'synonyms'; terms: string[]; online: boolean } | { type: 'ping' };

export interface OnlineStatus {
  used: boolean;
  denied: 'burst' | 'daily' | 'cooldown' | 'concurrency' | null;
  usedToday: number;
  perDay: number;
}

export type BgResponse =
  | { type: 'synonyms'; result: Record<string, string[]>; online: OnlineStatus }
  | { type: 'pong' }
  | { type: 'error'; reason: string };

export type ContentRequest = { type: 'toggle' } | { type: 'ping' };

export const STORAGE_KEYS = {
  settings: 'settings', // sync
  customSynonyms: 'customSynonyms', // local: Record<term, string[]>
  disabledSynonyms: 'synonymOverrides', // local: Record<term, Record<word, boolean>>
  onlineCache: 'onlineCache', // local: Record<term, {w: string[], t: number}>
  apiBudget: 'apiBudget', // local: {day, count}
  lastQuery: 'lastQuery', // session only
} as const;

/** Validate an untrusted `synonyms` request. Returns cleaned terms or null. */
export function sanitizeTerms(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const v of input.slice(0, LIMITS.maxTerms)) {
    if (typeof v !== 'string') return null;
    const s = v.trim().slice(0, LIMITS.maxTermLength);
    if (s) out.push(s);
  }
  return out;
}
