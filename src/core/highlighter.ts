/**
 * Paints matches with the CSS Custom Highlight API — no DOM mutation,
 * so it stays fast on huge pages and never breaks site layout.
 */

export const INK_COLORS = [
  { bg: 'rgba(214, 158, 26, .45)', ink: '#6b4c00' }, // mustard
  { bg: 'rgba(188, 74, 60, .38)', ink: '#5c1a12' }, // faded red
  { bg: 'rgba(52, 128, 122, .40)', ink: '#123d3a' }, // teal
  { bg: 'rgba(110, 82, 160, .38)', ink: '#2e1f4d' }, // plum
  { bg: 'rgba(76, 122, 60, .40)', ink: '#1f3d15' }, // moss
  { bg: 'rgba(196, 98, 140, .38)', ink: '#5a1738' }, // rose
  { bg: 'rgba(60, 100, 170, .38)', ink: '#132a4d' }, // ink blue
  { bg: 'rgba(160, 110, 60, .42)', ink: '#4a2c0c' }, // sepia
];

const STYLE_ID = 'paper-trail-highlight-styles';
export const PREFIX = 'paper-trail-';
export const ACTIVE = `${PREFIX}active`;
export const CLUSTER = `${PREFIX}cluster`;

export function supportsHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  const rules: string[] = INK_COLORS.map(
    (c, i) =>
      `::highlight(${PREFIX}${i}){background-color:${c.bg};color:${c.ink};text-decoration:underline dotted ${c.ink};text-decoration-thickness:1px;text-underline-offset:2px}`,
  );
  rules.push(
    `::highlight(${CLUSTER}){background-color:rgba(240,214,150,.28);box-decoration-break:clone}`,
    `::highlight(${ACTIVE}){background-color:#2b2620;color:#f7f3ea;text-decoration:none}`,
  );
  style.textContent = rules.join('\n');
  document.documentElement.appendChild(style);
}

export class Highlighter {
  private names = new Set<string>();

  paintGroups(rangesByGroup: Range[][]): void {
    ensureStyles();
    for (let i = 0; i < INK_COLORS.length; i++) {
      const name = `${PREFIX}${i}`;
      const ranges = rangesByGroup
        .filter((_, g) => g % INK_COLORS.length === i)
        .flat();
      if (ranges.length) {
        const h = new Highlight(...ranges);
        h.priority = 1;
        CSS.highlights.set(name, h);
        this.names.add(name);
      } else {
        CSS.highlights.delete(name);
      }
    }
  }

  paintClusters(ranges: Range[]): void {
    if (!ranges.length) {
      CSS.highlights.delete(CLUSTER);
      return;
    }
    const h = new Highlight(...ranges);
    h.priority = 0;
    CSS.highlights.set(CLUSTER, h);
    this.names.add(CLUSTER);
  }

  setActive(range: Range | null): void {
    if (!range) {
      CSS.highlights.delete(ACTIVE);
      return;
    }
    const h = new Highlight(range);
    h.priority = 10;
    CSS.highlights.set(ACTIVE, h);
    this.names.add(ACTIVE);
  }

  clear(): void {
    for (const n of this.names) CSS.highlights.delete(n);
    this.names.clear();
  }
}
