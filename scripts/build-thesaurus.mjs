#!/usr/bin/env node
/**
 * Builds public/thesaurus.json — the offline synonym table.
 *
 * Sources (all free):
 *  - WordNet 3.0 (Princeton, free license) via zaibacu/thesaurus JSONL dump
 *  - Moby Thesaurus II (public domain), used to top up common words
 *  - google-10000-english frequency list, used to decide which words are
 *    "common" enough to keep the file small
 *
 * Output format: { "word": ["syn", "syn", ...], ... }
 *
 * Usage: node scripts/build-thesaurus.mjs [--max 10]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX = Number(process.argv.find((a, i, arr) => arr[i - 1] === '--max') ?? 8);
const WORDNET = 'https://raw.githubusercontent.com/zaibacu/thesaurus/master/en_thesaurus.jsonl';
const MOBY = 'https://raw.githubusercontent.com/words/moby/master/words.txt';
const FREQ = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-no-swears.txt';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'public', 'thesaurus.json');

async function text(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

const ok = (w) => /^[a-z][a-z'-]*( [a-z][a-z'-]*)?$/.test(w) && w.length <= 24;

console.log('downloading…');
const [wnRaw, mobyRaw, freqRaw] = await Promise.all([text(WORDNET), text(MOBY), text(FREQ)]);

// frequency rank (lower = more common); unknown words rank last
const rank = new Map();
freqRaw.split('\n').map((s) => s.trim()).filter(Boolean).forEach((w, i) => rank.set(w, i));
const common = (w) => rank.has(w);
const rankOf = (w) => rank.get(w) ?? 1e9;
console.log(`common words: ${rank.size}`);

// WordNet synsets. The dump is inconsistent about which member carries the
// list, so treat {word} ∪ synonyms as one set and connect every pair.
const wn = new Map(); // word → Map<syn, senseCount>
const link = (a, b) => {
  if (a === b) return;
  const m = wn.get(a) ?? new Map();
  m.set(b, (m.get(b) ?? 0) + 1);
  wn.set(a, m);
};
for (const line of wnRaw.split('\n')) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (!Array.isArray(e.synonyms) || e.synonyms.length === 0) continue;
  const members = [e.word, ...e.synonyms]
    .map((s) => String(s).toLowerCase().replace(/_/g, ' '))
    .filter(ok);
  for (const a of members) for (const b of members) link(a, b);
}
console.log(`wordnet headwords with synonyms: ${wn.size}`);

// Moby: headword,syn,syn,...  (full lists, needed for reciprocity checks)
const moby = new Map();
for (const line of mobyRaw.split('\n')) {
  const cells = line.split(',');
  const w = cells[0]?.trim().toLowerCase();
  if (!w || !ok(w)) continue;
  const syns = new Set();
  for (let i = 1; i < cells.length; i++) {
    const t = cells[i].trim().toLowerCase();
    if (t !== w && ok(t)) syns.add(t);
  }
  if (syns.size) moby.set(w, syns);
}
console.log(`moby headwords: ${moby.size}`);

// Score candidates:
//   WordNet synset member          +3 (per sense, capped)
//   Moby, listed in both directions +2
//   Moby, one direction, common     +1
// then order by score, then by frequency rank.
const out = {};
// "known" = a word an everyday reader would search for; keeps the file small
const known = (w) => common(w) || moby.has(w);
const heads = new Set([...wn.keys(), ...moby.keys()].filter(known));
for (const w of heads) {
  const scores = new Map();
  const bump = (s, n) => scores.set(s, (scores.get(s) ?? 0) + n);
  for (const [s, senses] of wn.get(w) ?? []) bump(s, 3 + Math.min(senses - 1, 2));
  const ms = moby.get(w);
  if (ms) {
    for (const s of ms) {
      const mutual = moby.get(s)?.has(w);
      if (mutual) bump(s, 2);
      else if (common(s) && common(w)) bump(s, 1);
    }
  }
  // rare headwords: don't let Moby's loose one-directional links in at all
  const minScore = common(w) ? 1 : 2;
  const ranked = [...scores.entries()]
    .filter(([s, sc]) => sc >= minScore && known(s))
    .sort((a, b) => b[1] - a[1] || rankOf(a[0]) - rankOf(b[0]))
    .map(([s]) => s);
  if (ranked.length) out[w] = ranked.slice(0, MAX);
}

await mkdir(path.dirname(outPath), { recursive: true });
const json = JSON.stringify(out);
await writeFile(outPath, json);
console.log(
  `wrote ${outPath}: ${Object.keys(out).length} headwords, ` +
    `${(json.length / 1024).toFixed(0)} KB raw, ${(gzipSync(json).length / 1024).toFixed(0)} KB gzipped`,
);
