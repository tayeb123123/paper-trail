/**
 * Query model + search over a TextIndex-like normalized string.
 * Pure functions: no DOM here, so this is unit-testable in node.
 */
import { AhoCorasick } from './aho-corasick';
import { normalizePattern, isWordChar } from './normalize';

export interface TermGroup {
  /** what the user typed */
  term: string;
  /** synonyms / variants that are currently enabled */
  alternates: string[];
}

export interface SearchOptions {
  wholeWord: boolean;
  /** also match simple inflections (run → runs, running, ran-not) */
  variants: boolean;
}

export interface Match {
  start: number; // normalized offsets
  end: number;
  group: number; // index into TermGroup[]
  /** the exact (normalized) pattern that matched */
  pattern: string;
}

export interface GroupStats {
  total: number;
  byPattern: Record<string, number>;
}

export interface SearchResult {
  matches: Match[]; // sorted by start
  stats: GroupStats[];
}

/** Generate cheap inflectional variants for a single word. */
export function inflect(word: string): string[] {
  if (!word || /\s/.test(word) || word.length < 3) return [word];
  const v = new Set<string>([word]);
  v.add(word + 's');
  v.add(word + 'es');
  v.add(word + 'ed');
  v.add(word + 'ing');
  v.add(word + 'er');
  v.add(word + 'ers');
  v.add(word + 'ly');
  if (word.endsWith('e')) {
    const stem = word.slice(0, -1);
    v.add(stem + 'ing');
    v.add(stem + 'ed');
    v.add(word + 'd');
    v.add(stem + 'er');
  }
  if (word.endsWith('y')) {
    const stem = word.slice(0, -1);
    v.add(stem + 'ies');
    v.add(stem + 'ied');
    v.add(stem + 'ier');
  }
  // doubled final consonant (run → running, big → bigger)
  if (/[aeiou][bdgmnprt]$/.test(word)) {
    const last = word[word.length - 1];
    v.add(word + last + 'ing');
    v.add(word + last + 'ed');
    v.add(word + last + 'er');
  }
  return [...v];
}

interface CompiledPattern {
  text: string;
  group: number;
}

export function compile(groups: TermGroup[], opts: SearchOptions) {
  const ac = new AhoCorasick();
  const patterns: CompiledPattern[] = [];
  const seen = new Map<string, number>();

  const addPattern = (raw: string, group: number) => {
    const text = normalizePattern(raw);
    if (!text) return;
    const key = text;
    if (seen.has(key)) return; // first group wins for identical patterns
    seen.set(key, patterns.length);
    patterns.push({ text, group });
    ac.add(text, patterns.length - 1);
  };

  groups.forEach((g, gi) => {
    const words = [g.term, ...g.alternates];
    for (const w of words) {
      if (opts.variants) inflect(normalizePattern(w)).forEach((v) => addPattern(v, gi));
      else addPattern(w, gi);
    }
  });
  ac.build();
  return { ac, patterns };
}

export function search(
  normalizedText: string,
  groups: TermGroup[],
  opts: SearchOptions,
): SearchResult {
  const { ac, patterns } = compile(groups, opts);
  const matches: Match[] = [];
  const stats: GroupStats[] = groups.map(() => ({ total: 0, byPattern: {} }));

  if (patterns.length === 0) return { matches, stats };

  ac.scan(normalizedText, (m) => {
    if (opts.wholeWord) {
      if (isWordChar(normalizedText[m.start - 1]) || isWordChar(normalizedText[m.end])) return;
    }
    const p = patterns[m.id];
    matches.push({ start: m.start, end: m.end, group: p.group, pattern: p.text });
  });

  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  // Drop matches fully contained inside a longer match of the same group
  // (e.g. "run" inside "running" in substring mode).
  const kept: Match[] = [];
  let lastEndByGroup: number[] = groups.map(() => -1);
  for (const m of matches) {
    if (m.end <= lastEndByGroup[m.group]) continue;
    lastEndByGroup[m.group] = m.end;
    kept.push(m);
    const s = stats[m.group];
    s.total++;
    s.byPattern[m.pattern] = (s.byPattern[m.pattern] ?? 0) + 1;
  }

  return { matches: kept, stats };
}

/** Split user input into distinct terms. Commas, semicolons or newlines. */
export function parseTerms(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,\n;]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
