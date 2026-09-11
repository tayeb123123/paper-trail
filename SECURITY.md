# Security

## Reporting

Please report vulnerabilities privately via GitHub's "Report a vulnerability"
button on the Security tab of this repository rather than opening a public
issue. You should get an acknowledgement within a few days.

## Design notes for reviewers

- **No secrets.** The extension uses no API keys, tokens or accounts. There is
  nothing in this repository, its build, or the published package to leak.
- **No host permissions.** Only `activeTab`, `scripting`, `storage`.
  The content script is injected on demand into the tab the user invokes it on.
- **Network.** The only remote endpoint is `https://api.datamuse.com`, called
  only when the user enables "online thesaurus" (off by default), only with the
  individual words the user typed, filtered to dictionary-like words, without
  cookies or referrer, and rate limited client-side. Enforced by the extension
  CSP: `connect-src 'self' https://api.datamuse.com`.
- **No remote code, no `eval`, no inline scripts.**
- **Page DOM is never rewritten.** Highlights use the CSS Custom Highlight API;
  the panel lives in a closed-off Shadow DOM and all rendered text is escaped.
- **Messaging.** The background worker only accepts messages from this
  extension's own id, originating from a tab, with validated and capped payloads.
- **Storage** contents are re-validated on load.
- **Signing key.** If you package a `.crx` locally, Chrome writes `key.pem`
  next to the build. It is git-ignored; never commit it — anyone holding it can
  publish updates under your extension id.

See [PRIVACY.md](PRIVACY.md) for the data-handling summary.
