import { lookup } from '../src/synonyms/service';
import { sanitizeTerms, type BgRequest, type BgResponse, type ContentRequest } from '../src/messages';

export default defineBackground(() => {
  // Let the content script keep the last query in *session* storage
  // (cleared when the browser closes) instead of on disk.
  chrome.storage.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

  // --- synonym service for content scripts -------------------------------
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (r: BgResponse) => void) => {
    // Only our own content scripts, running in a tab, may talk to us.
    if (sender.id !== chrome.runtime.id || !sender.tab) return false;
    if (!msg || typeof msg !== 'object') return false;
    const req = msg as Partial<BgRequest>;

    if (req.type === 'ping') {
      sendResponse({ type: 'pong' });
      return false;
    }
    if (req.type === 'synonyms') {
      const terms = sanitizeTerms((req as { terms?: unknown }).terms);
      if (!terms) {
        sendResponse({ type: 'error', reason: 'bad request' });
        return false;
      }
      const online = (req as { online?: unknown }).online === true;
      lookup(terms, online)
        .then((r) => sendResponse({ type: 'synonyms', result: r.result, online: r.online }))
        .catch(() => sendResponse({ type: 'error', reason: 'lookup failed' }));
      return true; // async
    }
    return false;
  });

  // --- open / close the panel --------------------------------------------
  async function toggleOnTab(tabId: number) {
    const msg: ContentRequest = { type: 'toggle' };
    try {
      await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      // content script not injected yet on this page → inject, then toggle
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          files: ['content-scripts/content.js'],
        });
        await chrome.tabs.sendMessage(tabId, msg);
      } catch {
        // chrome:// pages, the Web Store, PDFs etc. — nothing we can do
      }
    }
  }

  chrome.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) void toggleOnTab(tab.id);
  });

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-panel') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) void toggleOnTab(tab.id);
  });
});
