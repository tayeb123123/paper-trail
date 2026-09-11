import { describe, it, expect } from 'vitest';
import { AhoCorasick } from '../src/core/aho-corasick';
import { normalize, normalizePattern } from '../src/core/normalize';
import { search, parseTerms, inflect } from '../src/core/search';
import { findClusters } from '../src/core/clusters';

describe('normalize', () => {
  it('lowercases, strips diacritics, collapses whitespace, maps offsets', () => {
    const src = '  Héllo\n\n  Wörld  ';
    const n = normalize(src);
    expect(n.text).toBe('hello world');
    // 'w' of world is at index 11 in src
    expect(n.map[6]).toBe(src.indexOf('W'));
    expect(n.map[n.text.length]).toBe(src.length);
  });
});

describe('AhoCorasick', () => {
  it('finds overlapping patterns in one pass', () => {
    const ac = new AhoCorasick();
    ac.add('he', 0);
    ac.add('she', 1);
    ac.add('his', 2);
    ac.add('hers', 3);
    ac.build();
    const found: string[] = [];
    ac.scan('ushers', (m) => found.push(`${m.id}@${m.start}-${m.end}`));
    expect(found.sort()).toEqual(['0@2-4', '1@1-4', '3@2-6'].sort());
  });

  it('handles astral code points', () => {
    const ac = new AhoCorasick();
    ac.add('😀x', 0);
    ac.build();
    const found: [number, number][] = [];
    ac.scan('a😀xb', (m) => found.push([m.start, m.end]));
    expect(found).toEqual([[1, 4]]);
  });
});

describe('search', () => {
  const text = normalize('The fast fox ran quickly. A quick, rapid runner. Fastest of all: running fast.').text;

  it('matches terms and synonyms with whole-word boundaries', () => {
    const r = search(text, [{ term: 'fast', alternates: ['quick', 'rapid'] }], { wholeWord: true, variants: false });
    expect(r.stats[0].total).toBe(4); // fast, quick, rapid, fast  (not "fastest", not "quickly")
    expect(r.stats[0].byPattern).toEqual({ fast: 2, quick: 1, rapid: 1 });
  });

  it('variants pick up inflections', () => {
    const r = search(text, [{ term: 'run', alternates: [] }], { wholeWord: true, variants: true });
    expect(r.stats[0].byPattern).toMatchObject({ runner: 1, running: 1 });
    expect(r.stats[0].total).toBe(2);
  });

  it('substring mode drops nested matches of the same group', () => {
    const r = search(text, [{ term: 'fast', alternates: ['fastest'] }], { wholeWord: false, variants: false });
    // "fastest" contains "fast"; only the longer one should count
    expect(r.matches.filter((m) => m.pattern === 'fastest')).toHaveLength(1);
    expect(r.stats[0].total).toBe(3);
  });

  it('returns matches sorted by position across groups', () => {
    const r = search(text, [{ term: 'fox', alternates: [] }, { term: 'fast', alternates: [] }], { wholeWord: true, variants: false });
    const starts = r.matches.map((m) => m.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('parses comma / newline separated terms, deduping', () => {
    expect(parseTerms('fast, cheap\nreliable; Fast')).toEqual(['fast', 'cheap', 'reliable']);
  });

  it('inflect covers common suffixes', () => {
    expect(inflect('run')).toContain('running');
    expect(inflect('bake')).toContain('baking');
    expect(inflect('carry')).toContain('carries');
    expect(normalizePattern('  Café ')).toBe('cafe');
  });
});

describe('clusters', () => {
  const m = (start: number, group: number, len = 4) => ({ start, end: start + len, group, pattern: 'x' });

  it('groups nearby matches from different terms and scores them', () => {
    const matches = [m(0, 0), m(20, 1), m(30, 0), m(500, 0), m(900, 1), m(910, 2), m(925, 0)];
    const c = findClusters(matches, { window: 50, minDistinct: 2 });
    expect(c).toHaveLength(2);
    // the 3-term cluster wins
    expect(c[0].groups.sort()).toEqual([0, 1, 2]);
    expect(c[0].start).toBe(900);
    expect(c[1].groups.sort()).toEqual([0, 1]);
  });

  it('ignores runs with a single term', () => {
    const c = findClusters([m(0, 0), m(10, 0), m(20, 0)], { window: 50, minDistinct: 2 });
    expect(c).toHaveLength(0);
  });

  it('respects minMatches for single-term density mode', () => {
    const c = findClusters([m(0, 0), m(10, 0), m(20, 0), m(400, 0)], { window: 50, minDistinct: 1, minMatches: 3 });
    expect(c).toHaveLength(1);
    expect(c[0].matches).toHaveLength(3);
  });
});
