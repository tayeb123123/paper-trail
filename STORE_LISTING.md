# Chrome Web Store listing copy

## Name

Paper Trail — Find Words & Their Synonyms

## Short description (132 characters max)

Search a page for several words at once, including their synonyms, and see where they cluster together. Printed on a receipt.

## Detailed description

**Ctrl+F, but for the way you actually read.**

You're skimming a long article, a report, a contract, a forum thread. You're
not looking for one exact word — you're looking for an idea, and the author
might have said it three different ways. Paper Trail finds all of them at once.

**Search many things at the same time**
Type a few words separated by commas — `price, delivery, refund` — and every
one lights up on the page in its own colour. No more searching, closing,
searching again.

**Synonyms included**
Each word you type prints a list of synonyms underneath it. They're on by
default, so `fast` also finds `quick` and `rapid`. Don't want one? Click it to
switch it off. Missing one? Add your own. Your choices are remembered.

**Hot spots: where it all comes together**
The receipt lists the places on the page where several of your words appear
close to each other — the paragraph that's actually about what you're looking
for. Click a hot spot to jump straight there.

**It looks like a receipt, because it is one**
Your search prints out on a little strip of thermal paper: items, quantities,
a total, a barcode. It sits in the corner of the page and gets out of your way.
Drag it wherever you like.

**Fast on huge pages**
Built on the same kind of algorithm search engines use to match thousands of
words in one pass. Highlights are drawn by the browser without touching the
page, so nothing breaks and nothing slows down — even on very long documents
and live-updating pages.

**Private by design**
- Works entirely on your computer. What you read never leaves your browser.
- Runs only on the tab you open it on, only while it's open.
- No account, no tracking, no ads. No API keys.
- Optional "online thesaurus" (off by default) can fetch extra synonyms from
  the free Datamuse service. If you turn it on, only the words you type are
  sent — never the page — and never anything that looks like an email, number
  or code.

**How to use**
1. Press **Ctrl+Shift+F** (Windows/Linux) or **⌘+Shift+F** (Mac), or click the icon.
2. Type your words, separated by commas.
3. **Enter** jumps to the next match, **Shift+Enter** to the previous, **Esc** closes.

Options on the receipt: whole word · word variants (run → running, runs) ·
synonyms · online thesaurus · hot-spot distance.

Free and open source. Requires Chrome 105 or newer.

## Category

Productivity → Tools

## Single-purpose statement (for the review form)

Finds multiple user-entered terms and their synonyms on the current web page,
highlights them, and lists where they occur close together.

## Permission justifications (for the review form)

- **activeTab** — to read the text of the page the user invokes the extension on, only while they use it.
- **scripting** — to inject the search panel into that page on demand.
- **storage** — to save the user's preferences, custom synonyms, and a small cache of synonym lookups.

## Data usage disclosure (for the privacy tab)

- Does not collect or transmit page content, browsing history, or personal information.
- If the user enables "online thesaurus", the individual search words they type
  are sent to api.datamuse.com to fetch synonyms. This is off by default.
- No data is sold, used for advertising, or shared with third parties beyond the above.
- Full policy: PRIVACY.md in the repository.
