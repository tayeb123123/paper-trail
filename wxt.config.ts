import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  outDir: 'dist',
  manifest: {
    name: 'Paper Trail — find terms & synonyms',
    short_name: 'Paper Trail',
    description:
      'Multi-term find with synonyms and proximity hot spots. Printed on a receipt.',
    // activeTab: the page you invoke it on, only while you use it.
    // No host permissions at all — Datamuse is reached via CORS from the
    // service worker, and only when the user opts in.
    permissions: ['activeTab', 'scripting', 'storage'],
    minimum_chrome_version: '105',
    // Belt-and-braces: extension pages/workers may only fetch our own files
    // and the opt-in thesaurus API. No remote code, no inline scripts.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; connect-src 'self' https://api.datamuse.com",
    },
    commands: {
      'toggle-panel': {
        // Chrome reserves Ctrl/Cmd+Shift+F on macOS and silently refuses to
        // bind it, so use Alt(Option)+Shift+F everywhere. Users can change it
        // at chrome://extensions/shortcuts.
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Open / close Paper Trail on this page',
      },
    },
    action: { default_title: 'Paper Trail (Alt+Shift+F / ⌥⇧F)' },
  },
});
