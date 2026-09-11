/**
 * Text normalization with an offset map back to the source string.
 *
 * - lowercases
 * - strips diacritics (é → e)
 * - collapses runs of whitespace to a single space
 *
 * `map[i]` is the index in the original string of normalized char `i`.
 * `map[normalized.length]` is the original length (sentinel for end offsets).
 */
export interface Normalized {
  text: string;
  map: Uint32Array;
}

const COMBINING = /[\u0300-\u036f]/g;
const WS = /\s/;

export function normalize(src: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true; // trims leading whitespace

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (WS.test(ch)) {
      if (!lastWasSpace) {
        out.push(' ');
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    lastWasSpace = false;
    let low = ch.toLowerCase();
    if (low.length !== 1) low = ch; // e.g. 'İ' → 2 code units; keep original
    if (low.charCodeAt(0) > 127) {
      low = low.normalize('NFD').replace(COMBINING, '');
      if (low.length !== 1) low = ch.toLowerCase().slice(0, 1) || ch;
    }
    out.push(low);
    map.push(i);
  }
  // trailing space trim
  if (out.length && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  map.push(src.length);
  return { text: out.join(''), map: Uint32Array.from(map) };
}

/** Normalize a search pattern (no offset map needed). */
export function normalizePattern(p: string): string {
  return normalize(p).text;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}
