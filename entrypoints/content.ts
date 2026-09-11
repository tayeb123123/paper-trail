import { Panel } from '../src/ui/panel';
import type { ContentRequest } from '../src/messages';

declare global {
  interface Window {
    __paperTrail?: Panel;
  }
}

export default defineContentScript({
  // Injected on demand by the background script (activeTab), never on load.
  registration: 'runtime',
  main() {
    if (window.__paperTrail) return; // already injected on this page
    const panel = new Panel();
    window.__paperTrail = panel;

    chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse) => {
      // only accept commands from our own background worker, never from a tab
      if (sender.id !== chrome.runtime.id || sender.tab) return false;
      if (msg?.type === 'toggle') {
        panel.toggle();
        sendResponse({ ok: true });
      } else if (msg?.type === 'ping') {
        sendResponse({ ok: true });
      }
      return false;
    });
  },
});
