// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TextIndex } from '../src/core/text-index';
import { search } from '../src/core/search';

describe('TextIndex', () => {
  it('joins inline nodes without separators and blocks with newlines', () => {
    document.body.innerHTML = `
      <p>The quick <b>brown</b> fox</p>
      <script>var quick = 1;</script>
      <div hidden>quick fox hidden</div>
      <p>jumps <span>over</span></p>`;
    const idx = TextIndex.build(document);
    expect(idx.norm.text).toBe('the quick brown fox jumps over');
    // raw string keeps a hard break between the two paragraphs
    expect(idx.raw.replace(/\s+/g, ' ').trim()).toBe('The quick brown fox jumps over');
    expect(/fox\s*\n\s*jumps/.test(idx.raw)).toBe(true);
  });

  it('maps a phrase spanning nodes back to a Range', () => {
    document.body.innerHTML = `<p>a <em>quick</em> <b>brown</b> fox</p>`;
    const idx = TextIndex.build(document);
    const r = search(idx.norm.text, [{ term: 'quick brown fox', alternates: [] }], { wholeWord: true, variants: false });
    expect(r.matches).toHaveLength(1);
    const range = idx.rangeFromNormalized(r.matches[0].start, r.matches[0].end)!;
    expect(range.toString()).toBe('quick brown fox');
  });

  it('excludes given elements (our own UI)', () => {
    document.body.innerHTML = `<p>needle</p><div id="ui">needle</div>`;
    const idx = TextIndex.build(document, [document.getElementById('ui')!]);
    expect(idx.norm.text).toBe('needle');
  });
});
