# Paper Trail — Privacy Policy

_Last updated: 2026-09-10_

Paper Trail is a find-in-page tool. It is designed so that **the content of the
pages you read never leaves your browser.**

## What the extension does with page content

- When you open Paper Trail on a tab (keyboard shortcut or toolbar click), it
  reads the visible text of that tab **locally** to count and highlight matches.
- That text is kept in memory only while the panel is open and is discarded
  when you close it. It is never stored, logged, or transmitted.
- The extension runs only on the tab you invoke it on (`activeTab`). It does not
  run in the background on pages you visit.

## What may leave your browser

Nothing, unless you switch on **online thesaurus** (off by default).

If you turn it on:

- The **individual words you type** into the search box are sent to
  [Datamuse](https://www.datamuse.com/api/) (`api.datamuse.com`) to fetch
  synonyms. Nothing from the page is sent.
- Only plain dictionary-like words are sent: at most 3 words, letters only,
  2–40 characters. Anything containing digits, symbols, `@`, URLs or long
  strings is never sent.
- Requests are made without cookies or referrer, and are rate-limited
  (20 per minute, 1,000 per day) and cached for 30 days to minimize traffic.
- Datamuse's own privacy terms apply to those requests. Turn the option off at
  any time to stop all network activity.

## What is stored

| Data | Where | Why |
| --- | --- | --- |
| Options (whole word, variants, synonyms, online, hot-spot window) | `chrome.storage.sync` | keep your preferences across devices |
| Synonyms you added or switched off | `chrome.storage.local` | remember your choices |
| Cached Datamuse results (word → synonyms, 30-day expiry, capped) | `chrome.storage.local` | avoid repeat requests |
| Daily request counter | `chrome.storage.local` | enforce the rate limit |
| Your last search text | `chrome.storage.session` | restore it when you reopen the panel; cleared when Chrome closes |

No analytics, no telemetry, no accounts, no advertising identifiers.
Removing the extension deletes all of the above.

## Permissions

- `activeTab` — read the page you invoke it on, only while you use it
- `scripting` — inject the panel into that tab on demand
- `storage` — the items in the table above

The extension requests **no host permissions**.

## Contact

Open an issue on the project's GitHub repository (for security matters, use the
private "Report a vulnerability" form described in [SECURITY.md](SECURITY.md)).
