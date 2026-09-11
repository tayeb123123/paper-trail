# Paper Trail

Multi-term find for Chrome: type several items, get every one of them — plus
their synonyms — highlighted on the page at once, with **hot spots** where
several items appear close together. Printed on a receipt.

Everything is free: no paid APIs, no accounts, no build services.

## Use

1. `npm install` then `npm run build` → `dist/chrome-mv3/`
2. Chrome → `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick `dist/chrome-mv3`
3. On any page press **⌘⇧F** (mac) / **Ctrl+Shift+F**, or click the toolbar icon.

Type items separated by commas (`fast, cheap, reliable`). Each item prints as a
line with its match count ("qty"); synonyms print underneath as chips — click
one to include/exclude it, `+ add` to add your own. **Enter / Shift+Enter** step
through matches, **Esc** closes. Drag the header to move the receipt.

Options on the receipt:

- **whole word** — don't match inside longer words
- **variants** — also match simple inflections (run → runs, running, runner)
- **synonyms** — expand each item with the thesaurus
- **online thesaurus** — *off by default*. Top up synonyms from
  [Datamuse](https://www.datamuse.com/api/) (free, no key). Only the words you
  type are sent — never page content — and only if they look like ordinary words
  (no digits, symbols, emails, URLs). See [PRIVACY.md](PRIVACY.md).

**Hot spots** lists regions where different items land within *N* characters of
each other (default 160, editable), ranked by how many distinct items appear
and how dense they are. Click one to jump there.

## How it works

| Concern | Approach |
| --- | --- |
| Text extraction | `TreeWalker` over visible text nodes, including open shadow roots; skips `script/style/hidden`. One flat string with a node-offset table so any match maps back to a DOM `Range`. |
| Normalization | lowercase, diacritics stripped, whitespace collapsed — with an offset map back to the source. |
| Matching | **Aho-Corasick**: all terms + synonyms + variants compiled into one automaton, single pass over the page, `O(text + matches)`. Whole-word check applied post-match. |
| Synonyms | Offline table (`public/thesaurus.json`, ~2.5 MB) built from WordNet + Moby Thesaurus by `npm run thesaurus`; optional Datamuse top-up. Top 6 suggestions are on by default. |
| Clustering | Single sweep over position-sorted matches; gaps ≤ window join a cluster; clusters need ≥ 2 distinct items (≥ 3 hits when only one item). Score = distinct items × 10 + hits + density. |
| Highlighting | CSS Custom Highlight API (`CSS.highlights`, `::highlight()`): zero DOM mutation, so it's fast on huge pages and never breaks site layout. Chrome 105+. |
| Live pages | `MutationObserver` (debounced) re-indexes when the page changes. |
| Rate limiting | `src/synonyms/rate-limit.ts`: token bucket (20/min), persisted daily cap (1,000/day — Datamuse allows 100k), max 3 concurrent, exponential back-off on errors and `Retry-After` on 429, in-flight dedupe, 30-day cache capped at 1,500 entries. Lookups fire only after typing settles (650 ms), so one request per finished word. The receipt shows when the online path is paused. |
| Security | `activeTab` only; content script injected on demand, never on page load. **No host permissions** (Datamuse is reached via CORS from the worker). Strict extension CSP (`connect-src 'self' https://api.datamuse.com`). Messages are accepted only from our own extension id and validated/capped (≤ 20 terms, ≤ 64 chars). Storage is re-validated on load. All UI text is HTML-escaped; highlights use the Highlight API, so page DOM is never rewritten. Last query is session-only. |

## Limits

- Chrome's built-in PDF viewer is opaque to extensions; PDFs aren't searchable (yet). Open the PDF in a web viewer or as HTML.
- Cross-origin iframes are not searched in v1.
- Publishing to the Chrome Web Store requires a one-time $5 developer registration; loading unpacked (above) is free.

## Store listing checklist

- Upload `dist/paper-trail-<version>-chrome.zip` (`npm run zip`).
- Privacy tab: link/paste [PRIVACY.md](PRIVACY.md); declare *no* data collection
  except the optional, user-enabled synonym lookups; single purpose: "find
  multiple terms and their synonyms on the current page".
- Permission justifications: `activeTab` (read the invoked tab), `scripting`
  (inject the panel on demand), `storage` (preferences and synonym cache).
- Remote code: none. Host permissions: none.

## Develop

```sh
npm run dev        # WXT dev server with hot reload (opens Chrome with the extension)
npm test           # vitest: matcher, normalizer, clustering, text index
npm run thesaurus  # regenerate public/thesaurus.json from the free sources
npm run zip        # dist/*.zip for sharing / store upload
```

Layout:

```
entrypoints/background.ts   synonym service, keyboard command, on-demand injection
entrypoints/content.ts      mounts the receipt
src/core/                   normalize, aho-corasick, text-index, search, clusters, highlighter
src/synonyms/service.ts     offline table + Datamuse, cached
src/ui/panel.ts, receipt.css  the receipt (Shadow DOM, plain TS)
scripts/build-thesaurus.mjs, scripts/make-icons.mjs
```
