/**
 * Aho-Corasick multi-pattern matcher.
 *
 * Build once per query (O(total pattern length)), then scan any text in
 * O(text length + matches). Patterns and text are expected to be
 * pre-normalized with the same function (see normalize.ts).
 */
export interface ACMatch {
  /** start offset (inclusive) in the scanned text */
  start: number;
  /** end offset (exclusive) */
  end: number;
  /** pattern id passed to `add` */
  id: number;
}

interface Node {
  next: Map<string, number>;
  fail: number;
  /** pattern ids that end at this node */
  out: number[];
  depth: number;
}

export class AhoCorasick {
  private nodes: Node[] = [{ next: new Map(), fail: 0, out: [], depth: 0 }];
  private patternLength: number[] = [];
  private built = false;

  add(pattern: string, id: number): void {
    if (this.built) throw new Error('AhoCorasick: cannot add after build()');
    if (!pattern) return;
    let cur = 0;
    for (const ch of pattern) {
      let nxt = this.nodes[cur].next.get(ch);
      if (nxt === undefined) {
        nxt = this.nodes.length;
        this.nodes.push({
          next: new Map(),
          fail: 0,
          out: [],
          depth: this.nodes[cur].depth + 1,
        });
        this.nodes[cur].next.set(ch, nxt);
      }
      cur = nxt;
    }
    this.nodes[cur].out.push(id);
    this.patternLength[id] = pattern.length;
  }

  build(): void {
    if (this.built) return;
    this.built = true;
    const queue: number[] = [];
    for (const child of this.nodes[0].next.values()) {
      this.nodes[child].fail = 0;
      queue.push(child);
    }
    while (queue.length) {
      const u = queue.shift()!;
      for (const [ch, v] of this.nodes[u].next) {
        let f = this.nodes[u].fail;
        while (f !== 0 && !this.nodes[f].next.has(ch)) f = this.nodes[f].fail;
        const target = this.nodes[f].next.get(ch);
        this.nodes[v].fail = target !== undefined && target !== v ? target : 0;
        // merge outputs of fail link so every match is reported
        const failOut = this.nodes[this.nodes[v].fail].out;
        if (failOut.length) this.nodes[v].out = this.nodes[v].out.concat(failOut);
        queue.push(v);
      }
    }
  }

  /**
   * Scan `text`, calling `emit` for every match. Pattern lengths are in
   * UTF-16 code units, matching `String.prototype.length`, so offsets can be
   * used directly for slicing / Range creation.
   */
  scan(text: string, emit: (m: ACMatch) => void): void {
    if (!this.built) this.build();
    const nodes = this.nodes;
    let cur = 0;
    // iterate by code point so surrogate pairs match the trie keys
    let i = 0;
    while (i < text.length) {
      const cp = text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const width = cp > 0xffff ? 2 : 1;
      let nxt = nodes[cur].next.get(ch);
      while (nxt === undefined && cur !== 0) {
        cur = nodes[cur].fail;
        nxt = nodes[cur].next.get(ch);
      }
      cur = nxt ?? 0;
      i += width;
      const out = nodes[cur].out;
      if (out.length) {
        for (const id of out) {
          emit({ start: i - this.patternLength[id], end: i, id });
        }
      }
    }
  }

  get size(): number {
    return this.patternLength.length;
  }
}
