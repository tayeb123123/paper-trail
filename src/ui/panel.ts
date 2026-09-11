/**
 * The receipt. Owns UI state, runs searches, paints highlights.
 */
import css from './receipt.css?raw';
import { TextIndex } from '../core/text-index';
import { search, parseTerms, type TermGroup, type SearchResult, type Match } from '../core/search';
import { findClusters, type Cluster } from '../core/clusters';
import { Highlighter, INK_COLORS, supportsHighlights } from '../core/highlighter';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  STORAGE_KEYS,
  type Settings,
  type BgRequest,
  type BgResponse,
  type OnlineStatus,
} from '../messages';

type Dict = Record<string, string[]>;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Storage can be edited by other extensions with debugging access or by a
 *  buggy older version of ourselves; never trust its shape blindly. */
const cleanWord = (w: unknown): string | null =>
  typeof w === 'string' && w.trim() ? w.trim().toLowerCase().slice(0, LIMITS.maxTermLength) : null;

function sanitizeDict(v: unknown): Dict {
  const out: Dict = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    const key = cleanWord(k);
    if (!key || !Array.isArray(list)) continue;
    const words = list.map(cleanWord).filter((w): w is string => !!w).slice(0, LIMITS.maxCustomPerTerm);
    if (words.length) out[key] = words;
  }
  return out;
}

function sanitizeOverrides(v: unknown): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, m] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    const key = cleanWord(k);
    if (!key || !m || typeof m !== 'object') continue;
    const inner: Record<string, boolean> = {};
    for (const [w, on] of Object.entries(m as Record<string, unknown>).slice(0, 64)) {
      const word = cleanWord(w);
      if (word && typeof on === 'boolean') inner[word] = on;
    }
    out[key] = inner;
  }
  return out;
}

function sanitizeSettings(v: unknown): Partial<Settings> {
  if (!v || typeof v !== 'object') return {};
  const s = v as Record<string, unknown>;
  const out: Partial<Settings> = {};
  for (const k of ['wholeWord', 'variants', 'synonyms', 'online'] as const) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (typeof s.clusterWindow === 'number') out.clusterWindow = Math.max(20, Math.min(2000, s.clusterWindow));
  if (typeof s.clusterMinDistinct === 'number') out.clusterMinDistinct = Math.max(1, Math.min(8, s.clusterMinDistinct));
  return out;
}

const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export class Panel {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private root!: HTMLElement;
  private body!: HTMLElement;
  private textarea!: HTMLTextAreaElement;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private input = '';
  private terms: string[] = [];
  private synonyms: Dict = {}; // term → suggestions (from background)
  private loading = new Set<string>();
  /** term → { synonym → on/off } explicit user choices */
  private overrides: Record<string, Record<string, boolean>> = {};
  private custom: Dict = {}; // term → synonyms user added
  /** suggestions beyond this rank start switched off (click to enable) */
  private static readonly DEFAULT_ON = 6;
  private addingFor: string | null = null;

  private index: TextIndex | null = null;
  private indexDirty = true;
  private result: SearchResult = { matches: [], stats: [] };
  private ranges: (Range | null)[] = [];
  private clusters: Cluster[] = [];
  private clusterRanges: (Range | null)[] = [];
  private active = -1;
  private activeCluster = -1;

  private hl = new Highlighter();
  private observer: MutationObserver | null = null;
  private lastSearchMs = 0;
  private onlineStatus: OnlineStatus | null = null;

  private readonly runDebounced = debounce(() => this.run(), 140);
  /** synonym lookups wait until typing settles, so "f, fa, fas, fast" = 1 request */
  private readonly fetchDebounced = debounce(() => this.fetchMissingSynonyms(), 650);
  private readonly reindexDebounced = debounce(() => {
    this.indexDirty = true;
    if (this.terms.length) this.searchAndPaint();
  }, 450);

  get isOpen(): boolean {
    return this.host !== null;
  }

  toggle(): void {
    this.isOpen ? this.close() : void this.open();
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    await this.loadState();
    this.mount();
    this.observe();
    if (this.input.trim()) this.run();
    this.textarea.focus();
    this.textarea.select();
  }

  close(): void {
    if (!this.host) return;
    this.hl.clear();
    this.observer?.disconnect();
    this.observer = null;
    const host = this.host;
    this.root.classList.add('closing');
    setTimeout(() => host.remove(), 240);
    this.host = null;
    this.shadow = null;
  }

  // ----------------------------------------------------------------- state
  private async loadState() {
    try {
      const sync = await chrome.storage.sync.get([STORAGE_KEYS.settings]);
      this.settings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(sync[STORAGE_KEYS.settings]) };
      const local = await chrome.storage.local.get([STORAGE_KEYS.customSynonyms, STORAGE_KEYS.disabledSynonyms]);
      this.custom = sanitizeDict(local[STORAGE_KEYS.customSynonyms]);
      this.overrides = sanitizeOverrides(local[STORAGE_KEYS.disabledSynonyms]);
      if (!this.input) {
        // last query lives in session storage only: gone when the browser closes
        const session: Record<string, unknown> =
          (await chrome.storage.session?.get(STORAGE_KEYS.lastQuery).catch(() => ({}))) ?? {};
        const q = session[STORAGE_KEYS.lastQuery];
        if (typeof q === 'string') this.input = q.slice(0, LIMITS.maxTerms * LIMITS.maxTermLength);
      }
    } catch {
      /* storage unavailable (e.g. extension reloaded) — use defaults */
    }
  }
  private saveSettings() {
    chrome.storage.sync.set({ [STORAGE_KEYS.settings]: this.settings }).catch(() => {});
  }
  private saveDicts() {
    chrome.storage.local
      .set({ [STORAGE_KEYS.customSynonyms]: this.custom, [STORAGE_KEYS.disabledSynonyms]: this.overrides })
      .catch(() => {});
    chrome.storage.session?.set({ [STORAGE_KEYS.lastQuery]: this.input }).catch(() => {});
  }

  // ----------------------------------------------------------------- mount
  private mount() {
    const host = document.createElement('paper-trail-receipt');
    this.host = host;
    this.shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    this.shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'receipt';
    root.innerHTML = `
      <div class="tear top"></div>
      <div class="paper">
        <button class="close" title="Close (Esc)" aria-label="Close">×</button>
        <div class="head" data-drag>
          <h1 class="brand">Paper Trail<small>find · synonyms · hot spots</small></h1>
          <div class="meta"><span data-host>${esc(location.hostname || 'this page')}</span><span data-time></span></div>
        </div>
        <hr class="rule" />
        <div class="field">
          <label>items (comma separated)</label>
          <textarea class="terms" rows="2" spellcheck="false" placeholder="e.g. fast, cheap, reliable">${esc(this.input)}</textarea>
        </div>
        <div class="opts">
          <label><input type="checkbox" data-opt="wholeWord"> whole word</label>
          <label><input type="checkbox" data-opt="variants"> variants</label>
          <label><input type="checkbox" data-opt="synonyms"> synonyms</label>
          <label title="Datamuse — free, no key. Off by default. Only the words you type are sent; never page content."><input type="checkbox" data-opt="online"> online thesaurus</label>
        </div>
        <div class="notice" data-notice hidden></div>
        ${supportsHighlights() ? '' : '<div class="notice">This browser lacks the CSS Highlight API (Chrome 105+). Counts work, paint does not.</div>'}
        <hr class="rule" />
        <div class="body"></div>
        <hr class="rule strong" />
        <div class="total"><span>TOTAL</span><span data-total>0</span></div>
        <div class="nav">
          <span data-pos>— / —</span>
          <span class="btns">
            <button data-nav="prev" title="Previous (Shift+Enter)">‹</button>
            <button data-nav="next" title="Next (Enter)">›</button>
          </span>
          <span><kbd>esc</kbd> close</span>
        </div>
        <div class="barcode"></div>
        <div class="thanks">thank you for reading<br><span class="faded" data-timing>—</span></div>
      </div>
      <div class="tear bottom"></div>`;
    this.shadow.appendChild(root);
    this.root = root;
    this.body = root.querySelector('.body')!;
    this.textarea = root.querySelector('textarea.terms')!;
    (root.querySelector('[data-time]') as HTMLElement).textContent = new Date().toLocaleString(undefined, {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    for (const cb of root.querySelectorAll<HTMLInputElement>('[data-opt]')) {
      const key = cb.dataset.opt as keyof Settings;
      cb.checked = Boolean(this.settings[key]);
      cb.addEventListener('change', () => {
        (this.settings as unknown as Record<string, unknown>)[key] = cb.checked;
        this.saveSettings();
        if (key === 'online') {
          this.synonyms = {}; // refetch with/without Datamuse
          this.onlineStatus = null;
        }
        this.renderNotice();
        this.run();
      });
    }
    this.renderNotice();

    this.textarea.addEventListener('input', () => {
      this.input = this.textarea.value;
      this.runDebounced();
    });
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    root.querySelector('.close')!.addEventListener('click', () => this.close());
    root.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) =>
      b.addEventListener('click', () => this.step(b.dataset.nav === 'prev' ? -1 : 1)),
    );
    this.body.addEventListener('click', (e) => this.onBodyClick(e));
    this.body.addEventListener('keydown', (e) => this.onBodyKey(e));
    this.body.addEventListener('change', (e) => this.onBodyChange(e));
    this.enableDrag(root.querySelector('[data-drag]')!);

    document.documentElement.appendChild(host);
    this.renderBody();
  }

  private enableDrag(handle: HTMLElement) {
    let sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const host = this.host!;
      const r = host.getBoundingClientRect();
      // switch from right-anchored to left-anchored once the user drags
      host.style.left = `${r.left}px`;
      host.style.top = `${r.top}px`;
      host.style.right = 'auto';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        host.style.left = `${Math.max(0, ox + ev.clientX - sx)}px`;
        host.style.top = `${Math.max(0, oy + ev.clientY - sy)}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private observe() {
    this.observer?.disconnect();
    const ours = (n: Node) =>
      (this.host && (n === this.host || this.host.contains(n))) || (n as Element).id === 'paper-trail-highlight-styles';
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (ours(r.target)) continue;
        if (r.type === 'childList') {
          const nodes = [...r.addedNodes, ...r.removedNodes];
          if (nodes.length && nodes.every(ours)) continue;
        }
        this.reindexDebounced();
        return;
      }
    });
    this.observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  }

  // ------------------------------------------------------------------ run
  /** Parse input, fetch missing synonyms, search. */
  private run() {
    this.terms = parseTerms(this.input)
      .slice(0, LIMITS.maxTerms)
      .map((t) => t.slice(0, LIMITS.maxTermLength));
    this.saveDicts();
    if (this.settings.synonyms) {
      // search right away with whatever synonyms we already have; ask for
      // the rest only once typing has settled
      this.fetchDebounced();
    }
    this.searchAndPaint();
  }

  private fetchMissingSynonyms() {
    if (!this.isOpen || !this.settings.synonyms) return;
    const missing = this.terms.filter((t) => !(t.toLowerCase() in this.synonyms) && !this.loading.has(t.toLowerCase()));
    if (missing.length) void this.fetchSynonyms(missing);
  }

  private async fetchSynonyms(terms: string[]) {
    terms.forEach((t) => this.loading.add(t.toLowerCase()));
    this.renderBody();
    try {
      const req: BgRequest = { type: 'synonyms', terms, online: this.settings.online };
      const res = (await chrome.runtime.sendMessage(req)) as BgResponse | undefined;
      if (res?.type === 'synonyms') {
        for (const t of terms) {
          const list = res.result[t];
          this.synonyms[t.toLowerCase()] = Array.isArray(list) ? list.filter((w) => typeof w === 'string').slice(0, 12) : [];
        }
        this.onlineStatus = res.online;
      } else {
        for (const t of terms) this.synonyms[t.toLowerCase()] = [];
      }
    } catch {
      for (const t of terms) this.synonyms[t.toLowerCase()] = [];
    } finally {
      terms.forEach((t) => this.loading.delete(t.toLowerCase()));
    }
    if (this.isOpen) {
      this.searchAndPaint();
      this.renderNotice();
    }
  }

  /** Consent line when online is on; rate-limit line when it's paused. */
  private renderNotice() {
    const el = this.root?.querySelector<HTMLElement>('[data-notice]');
    if (!el) return;
    if (!this.settings.online || !this.settings.synonyms) {
      el.hidden = true;
      return;
    }
    const st = this.onlineStatus;
    let text = 'online: only the words you type are sent to api.datamuse.com — never page content.';
    if (st?.denied === 'daily') text = `online thesaurus paused: daily allowance used (${st.usedToday}/${st.perDay}). offline synonyms still work.`;
    else if (st?.denied === 'cooldown') text = 'online thesaurus paused briefly (service busy). offline synonyms still work.';
    else if (st?.denied === 'burst') text = 'online thesaurus catching up — a few lookups deferred.';
    el.textContent = text;
    el.hidden = false;
  }

  private alternatesFor(term: string): { word: string; on: boolean; custom: boolean }[] {
    const key = term.toLowerCase();
    const ov = this.overrides[key] ?? {};
    const list: { word: string; on: boolean; custom: boolean }[] = [];
    for (const w of this.custom[key] ?? []) list.push({ word: w, on: ov[w] ?? true, custom: true });
    if (this.settings.synonyms) {
      (this.synonyms[key] ?? []).forEach((w, i) => {
        if (list.some((x) => x.word === w)) return;
        list.push({ word: w, on: ov[w] ?? i < Panel.DEFAULT_ON, custom: false });
      });
    }
    return list;
  }

  private ensureIndex(): TextIndex {
    if (!this.index || this.indexDirty) {
      this.index = TextIndex.build(document, this.host ? [this.host] : []);
      this.indexDirty = false;
    }
    return this.index;
  }

  private searchAndPaint() {
    if (!this.isOpen) return;
    const t0 = performance.now();
    if (this.terms.length === 0) {
      this.result = { matches: [], stats: [] };
      this.ranges = [];
      this.clusters = [];
      this.clusterRanges = [];
      this.active = -1;
      this.activeCluster = -1;
      this.hl.clear();
      this.renderBody();
      this.renderTotals(0);
      return;
    }
    const index = this.ensureIndex();
    const groups: TermGroup[] = this.terms.map((term) => ({
      term,
      alternates: this.alternatesFor(term).filter((a) => a.on).map((a) => a.word),
    }));
    this.result = search(index.norm.text, groups, { wholeWord: this.settings.wholeWord, variants: this.settings.variants });

    // ranges for paint + navigation
    const byGroup: Range[][] = groups.map(() => []);
    this.ranges = this.result.matches.map((m) => {
      const r = index.rangeFromNormalized(m.start, m.end);
      if (r) byGroup[m.group].push(r);
      return r;
    });

    // hot spots
    // with a single item, "hot spots" degrade gracefully to dense regions
    this.clusters = findClusters(this.result.matches, {
      window: this.settings.clusterWindow,
      minDistinct: Math.min(this.settings.clusterMinDistinct, Math.max(1, groups.length)),
      minMatches: groups.length > 1 ? 2 : 3,
    }).slice(0, 12);
    this.clusterRanges = this.clusters.map((c) => index.rangeFromNormalized(c.start, c.end));

    if (supportsHighlights()) {
      this.hl.paintGroups(byGroup);
      this.hl.paintClusters(this.clusterRanges.filter((r): r is Range => r !== null));
    }

    // keep the active pointer sane across re-runs
    if (this.active >= this.ranges.length) this.active = this.ranges.length ? 0 : -1;
    if (this.active === -1 && this.ranges.length) this.active = this.firstVisibleMatch();
    this.activeCluster = -1;
    this.paintActive(false);

    this.lastSearchMs = performance.now() - t0;
    this.renderBody();
    this.renderTotals(this.result.matches.length);
  }

  private firstVisibleMatch(): number {
    const top = 0;
    for (let i = 0; i < this.ranges.length; i++) {
      const r = this.ranges[i];
      if (!r) continue;
      const rect = r.getBoundingClientRect();
      if (rect.bottom >= top) return i;
    }
    return 0;
  }

  private paintActive(scroll: boolean) {
    const r = this.active >= 0 ? this.ranges[this.active] : null;
    if (supportsHighlights()) this.hl.setActive(r ?? null);
    if (r && scroll) this.scrollTo(r);
    this.renderTotals(this.result.matches.length);
  }

  private scrollTo(r: Range) {
    const el = r.startContainer.parentElement;
    const rect = r.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const y = rect.top + window.scrollY - window.innerHeight / 2;
    const x = rect.left + window.scrollX - window.innerWidth / 2;
    window.scrollTo({ top: Math.max(0, y), left: Math.max(0, x), behavior: 'smooth' });
    // nested scroll containers: let the browser resolve them too
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }

  private step(dir: 1 | -1) {
    const n = this.ranges.length;
    if (!n) return;
    this.active = ((this.active + dir) % n + n) % n;
    this.activeCluster = -1;
    this.paintActive(true);
    this.markActiveSpot();
  }

  private jumpToGroup(g: number) {
    const idxs = this.result.matches.map((m, i) => (m.group === g ? i : -1)).filter((i) => i >= 0);
    if (!idxs.length) return;
    const after = idxs.find((i) => i > this.active);
    this.active = after ?? idxs[0];
    this.activeCluster = -1;
    this.paintActive(true);
    this.markActiveSpot();
  }

  private jumpToCluster(ci: number) {
    const c = this.clusters[ci];
    if (!c) return;
    const first = this.result.matches.indexOf(c.matches[0]);
    if (first >= 0) this.active = first;
    this.activeCluster = ci;
    this.paintActive(true);
    this.markActiveSpot();
  }

  private markActiveSpot() {
    this.body.querySelectorAll<HTMLElement>('.spot').forEach((s, i) => s.classList.toggle('active', i === this.activeCluster));
  }

  // --------------------------------------------------------------- render
  private renderTotals(total: number) {
    if (!this.root) return;
    (this.root.querySelector('[data-total]') as HTMLElement).textContent = String(total);
    (this.root.querySelector('[data-pos]') as HTMLElement).textContent =
      total && this.active >= 0 ? `${this.active + 1} / ${total}` : `— / ${total || '—'}`;
    (this.root.querySelector('[data-timing]') as HTMLElement).textContent =
      total || this.terms.length
        ? `${(this.index?.length ?? 0).toLocaleString()} chars · ${this.lastSearchMs.toFixed(1)} ms`
        : 'printed on 100% recycled pixels';
    const stamp = this.root.querySelector('.stamp');
    const allFound = this.terms.length > 1 && this.result.stats.every((s) => s.total > 0);
    if (allFound && !stamp) {
      const s = document.createElement('div');
      s.className = 'stamp';
      s.textContent = 'all found';
      this.root.querySelector('.paper')!.appendChild(s);
    } else if (!allFound && stamp) stamp.remove();
  }

  private renderBody() {
    if (!this.body) return;
    if (this.terms.length === 0) {
      this.body.innerHTML = `<div class="empty">Type one or more items above. Separate with commas.<br>Synonyms print underneath each item; hot spots list where several items appear close together.</div>`;
      return;
    }
    const items = this.terms
      .map((term, gi) => {
        const color = INK_COLORS[gi % INK_COLORS.length];
        const st = this.result.stats[gi];
        const total = st?.total ?? 0;
        const alts = this.alternatesFor(term);
        const loading = this.loading.has(term.toLowerCase());
        const chips = alts
          .map((a) => {
            const n = st?.byPattern ? this.countFor(st.byPattern, a.word) : 0;
            return `<button class="chip ${a.on ? '' : 'off'} ${a.custom ? 'custom' : ''}" data-chip="${esc(a.word)}" data-term="${esc(term)}" title="${a.on ? 'click to exclude' : 'click to include'}"><b>${esc(a.word)}</b>${a.on && n ? ` ×${n}` : ''}</button>`;
          })
          .join('');
        const adding =
          this.addingFor === term
            ? `<input class="add" data-add-input="${esc(term)}" placeholder="add synonym…" autofocus>`
            : `<button class="chip add" data-add="${esc(term)}" title="add your own synonym">+ add</button>`;
        return `<div class="item">
          <div class="item-row" data-group="${gi}" title="jump to next match">
            <span class="swatch" style="background:${color.bg};outline:1px solid ${color.ink}"></span>
            <span class="name">${esc(term)}</span><span class="dots"></span>
            <span class="qty ${total ? '' : 'zero'}">${total}</span>
          </div>
          <div class="syns">${chips}${loading ? '<span class="loading">looking up…</span>' : ''}${adding}</div>
        </div>`;
      })
      .join('');

    const spots = this.clusters.length
      ? this.clusters
          .map((c, i) => {
            const idx = this.index!;
            const terms = c.groups
              .map((g) => `<i style="background:${INK_COLORS[g % INK_COLORS.length].bg};outline:1px solid ${INK_COLORS[g % INK_COLORS.length].ink}"></i>${esc(this.terms[g])}`)
              .join(' · ');
            return `<button class="spot ${i === this.activeCluster ? 'active' : ''}" data-spot="${i}">
              <span class="line1"><span class="rank">#${i + 1}</span><span class="terms">${terms}</span><span class="score">${c.matches.length} hits · ${c.score}</span></span>
              <span class="excerpt">${esc(idx.excerpt(c.start, c.end, 36))}</span>
            </button>`;
          })
          .join('')
      : `<div class="empty">${this.terms.length < 2 ? 'Add a second item to find places where items appear together.' : 'No spots where items appear within ' + this.settings.clusterWindow + ' characters of each other.'}</div>`;

    this.body.innerHTML = `
      <div class="cols"><span>item</span><span>qty</span></div>
      ${items}
      <hr class="rule" />
      <div class="hot">
        <h4><span>hot spots</span><span>within <input type="number" min="20" max="2000" step="20" data-window value="${this.settings.clusterWindow}"> chars</span></h4>
        ${spots}
      </div>`;

    const add = this.body.querySelector<HTMLInputElement>('[data-add-input]');
    if (add) add.focus();
  }

  private countFor(byPattern: Record<string, number>, word: string): number {
    // variants share the same root; sum any pattern that starts with the word
    let n = 0;
    const w = word.toLowerCase();
    for (const [p, c] of Object.entries(byPattern)) if (p === w || (p.startsWith(w) && p.length - w.length <= 4)) n += c;
    return n;
  }

  // --------------------------------------------------------------- events
  private onBodyClick(e: Event) {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>('[data-chip]');
    if (chip) {
      const term = chip.dataset.term!.toLowerCase();
      const word = chip.dataset.chip!;
      const wasOn = !chip.classList.contains('off');
      (this.overrides[term] ??= {})[word] = !wasOn;
      this.saveDicts();
      this.searchAndPaint();
      return;
    }
    const add = t.closest<HTMLElement>('[data-add]');
    if (add) {
      this.addingFor = add.dataset.add!;
      this.renderBody();
      return;
    }
    const row = t.closest<HTMLElement>('[data-group]');
    if (row) {
      this.jumpToGroup(Number(row.dataset.group));
      return;
    }
    const spot = t.closest<HTMLElement>('[data-spot]');
    if (spot) this.jumpToCluster(Number(spot.dataset.spot));
  }

  private onBodyKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.matches('[data-add-input]')) {
      const input = t as HTMLInputElement;
      if (e.key === 'Enter') {
        e.preventDefault();
        const term = input.dataset.addInput!.toLowerCase();
        const words = parseTerms(input.value)
          .map((w) => w.toLowerCase().slice(0, LIMITS.maxTermLength))
          .filter((w) => w && w !== term);
        if (words.length) {
          const list = this.custom[term] ?? [];
          for (const w of words) {
            if (list.length >= LIMITS.maxCustomPerTerm) break;
            if (!list.includes(w)) list.push(w);
            (this.overrides[term] ??= {})[w] = true;
          }
          this.custom[term] = list;
          this.saveDicts();
        }
        this.addingFor = null;
        this.searchAndPaint();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.addingFor = null;
        this.renderBody();
      }
    }
  }

  private onBodyChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.matches('[data-window]')) {
      const v = Math.max(20, Math.min(2000, Number(t.value) || 160));
      this.settings.clusterWindow = v;
      this.saveSettings();
      this.searchAndPaint();
    }
  }

}
