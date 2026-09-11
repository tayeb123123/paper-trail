/**
 * Builds a flat, searchable string from the visible text of a document
 * (including open shadow roots), plus the bookkeeping needed to turn an
 * offset in that string back into a DOM Range.
 */
import { normalize, type Normalized } from './normalize';

interface Segment {
  /** start offset of this text node in the concatenated (raw) string */
  start: number;
  end: number;
  node: Text;
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'SVG',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'OBJECT',
  'EMBED',
]);

const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I',
  'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
  'TIME', 'U', 'VAR', 'WBR', 'FONT', 'LABEL', 'INS', 'DEL', 'BIG', 'TT',
]);

export class TextIndex {
  readonly raw: string;
  readonly norm: Normalized;
  private segments: Segment[];

  private constructor(raw: string, segments: Segment[]) {
    this.raw = raw;
    this.segments = segments;
    this.norm = normalize(raw);
  }

  /**
   * @param root      document or element to index
   * @param excludes  elements whose subtree must be ignored (our own UI)
   */
  static build(root: Node, excludes: Element[] = []): TextIndex {
    const parts: string[] = [];
    const segments: Segment[] = [];
    let length = 0;
    let lastBlock: Element | null = null;
    const blockCache = new WeakMap<Element, Element>();
    const visCache = new WeakMap<Element, boolean>();

    const isVisible = (el: Element): boolean => {
      let v = visCache.get(el);
      if (v !== undefined) return v;
      const anyEl = el as Element & { checkVisibility?: () => boolean };
      v = anyEl.checkVisibility ? anyEl.checkVisibility() : true;
      visCache.set(el, v);
      return v;
    };

    const blockAncestor = (el: Element): Element => {
      let b = blockCache.get(el);
      if (b) return b;
      let cur: Element | null = el;
      while (cur && INLINE_TAGS.has(cur.tagName)) {
        const parent: Node | null = cur.parentNode;
        cur = parent instanceof Element ? parent : (parent as ShadowRoot | null)?.host ?? null;
      }
      b = cur ?? el;
      blockCache.set(el, b);
      return b;
    };

    const walk = (scope: Node) => {
      const doc = scope.ownerDocument ?? (scope as Document);
      const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const el = n as Element;
            if (SKIP_TAGS.has(el.tagName) || excludes.includes(el)) return NodeFilter.FILTER_REJECT;
            if (el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP; // descend, but don't "accept" the element itself
          }
          // keep whitespace-only nodes: they separate "<em>quick</em> <b>brown</b>"
          return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });

      // Shadow roots aren't traversed by TreeWalker; collect hosts as we go.
      const hosts: Element[] = [];
      const collectHosts = (el: Element) => {
        if (el.shadowRoot) hosts.push(el);
      };
      // cheap pass for shadow hosts under this scope
      if (scope instanceof Element || scope instanceof Document || scope instanceof ShadowRoot) {
        (scope as ParentNode).querySelectorAll('*').forEach(collectHosts);
      }

      let n: Node | null = walker.nextNode();
      while (n) {
        const text = n as Text;
        const parent = text.parentElement ?? ((text.parentNode as ShadowRoot | null)?.host ?? null);
        if (parent && isVisible(parent)) {
          const block = blockAncestor(parent);
          if (lastBlock && block !== lastBlock) {
            parts.push('\n');
            length += 1;
          }
          lastBlock = block;
          const value = text.nodeValue!;
          segments.push({ start: length, end: length + value.length, node: text });
          parts.push(value);
          length += value.length;
        }
        n = walker.nextNode();
      }
      for (const h of hosts) {
        if (excludes.includes(h)) continue;
        parts.push('\n');
        length += 1;
        lastBlock = null;
        walk(h.shadowRoot!);
      }
    };

    walk(root);
    return new TextIndex(parts.join(''), segments);
  }

  /** Number of raw characters indexed. */
  get length(): number {
    return this.raw.length;
  }

  /** Map a [start,end) in the *normalized* string to a DOM Range. */
  rangeFromNormalized(start: number, end: number): Range | null {
    const rs = this.norm.map[start];
    const re = this.norm.map[end - 1] + 1; // inclusive last char → exclusive end
    return this.rangeFromRaw(rs, re);
  }

  /** Map a [start,end) in the *raw* concatenated string to a DOM Range. */
  rangeFromRaw(start: number, end: number): Range | null {
    const s = this.locate(start);
    const e = this.locate(end - 1);
    if (!s || !e) return null;
    try {
      const range = document.createRange();
      range.setStart(s.node, start - s.start);
      range.setEnd(e.node, end - e.start);
      return range;
    } catch {
      return null;
    }
  }

  /** Binary search for the segment containing raw offset `pos`. */
  private locate(pos: number): Segment | null {
    const segs = this.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid];
      if (pos < s.start) hi = mid - 1;
      else if (pos >= s.end) lo = mid + 1;
      else return s;
    }
    // `pos` landed on a separator we inserted; snap to nearest segment.
    if (lo < segs.length) return segs[lo];
    return segs[segs.length - 1] ?? null;
  }

  /** Short excerpt of raw text around a normalized [start,end). */
  excerpt(start: number, end: number, pad = 40): string {
    const rs = this.norm.map[start];
    const re = this.norm.map[end - 1] + 1;
    const a = Math.max(0, rs - pad);
    const b = Math.min(this.raw.length, re + pad);
    return (a > 0 ? '…' : '') + this.raw.slice(a, b).replace(/\s+/g, ' ').trim() + (b < this.raw.length ? '…' : '');
  }
}
