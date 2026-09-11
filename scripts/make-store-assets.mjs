#!/usr/bin/env node
/**
 * Generates Chrome Web Store listing assets into store/:
 *   - small-promo-tile.png  (440 × 280)
 *   - screenshot-1280x800.png (1280 × 800)
 *   - marquee-promo-tile.png  (1400 × 560)  — optional
 *
 * Uses the installed Chrome + the built extension. Run after `npm run build`.
 *
 * Usage: node scripts/make-store-assets.mjs
 */
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = path.join(root, 'store');
const built = path.join(root, 'dist', 'chrome-mv3');
const profile = '/tmp/pt-store-assets-profile';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(built)) {
  console.error('Run `npm run build` first — dist/chrome-mv3 is missing.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
let puppeteer;
for (const candidate of [
  path.join(root, 'node_modules', 'puppeteer-core'),
  '/tmp/pt-smoke/node_modules/puppeteer-core',
]) {
  try {
    puppeteer = require(candidate);
    break;
  } catch {
    /* try next */
  }
}
if (!puppeteer) {
  console.error('Install puppeteer-core: npm i -D puppeteer-core');
  process.exit(1);
}

// Staging copy with file:// host permission so we can inject on the local demo.
const staging = '/tmp/pt-store-ext';
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
execSync(`cp -R "${built}/." "${staging}/"`);
const manifest = JSON.parse(await readFile(path.join(staging, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['file:///*'];
await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest));

await mkdir(outDir, { recursive: true });
await rm(profile, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  enableExtensions: [staging],
  args: ['--no-first-run', '--hide-scrollbars'],
  userDataDir: profile,
});

async function openPanelOn(page) {
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
  const sw = await swT.worker();
  await sw.evaluate(() => chrome.storage.sync.set({ settings: { online: false, synonyms: true, wholeWord: true, variants: true } }));
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  }, tabId);
  await page.waitForSelector('paper-trail-receipt', { timeout: 10000 });
  const ta = await page.evaluateHandle(() =>
    document.querySelector('paper-trail-receipt').shadowRoot.querySelector('textarea'),
  );
  await ta.focus();
  await page.keyboard.type('fast, cheap, reliable', { delay: 25 });
  await new Promise((r) => setTimeout(r, 900));
  return sw;
}

try {
  // ---------- screenshot 1280×800 ----------
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(outDir, 'demo.html'), { waitUntil: 'networkidle0' });
  await openPanelOn(page);
  // nudge the receipt into a nice composition
  await page.evaluate(() => {
    const host = document.querySelector('paper-trail-receipt');
    host.style.left = 'auto';
    host.style.right = '28px';
    host.style.top = '36px';
  });
  await new Promise((r) => setTimeout(r, 400));
  const shotPath = path.join(outDir, 'screenshot-1280x800.png');
  await page.screenshot({ path: shotPath, type: 'png' });
  console.log('wrote', shotPath);

  // ---------- small promo tile 440×280 ----------
  // Capture the receipt alone on a warm paper-toned stage, then composite.
  const tile = await browser.newPage();
  await tile.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  await tile.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;width:440px;height:280px;overflow:hidden;
      background:
        radial-gradient(ellipse at 30% 20%, #fff8ea 0%, transparent 55%),
        radial-gradient(ellipse at 80% 90%, #e8dcc4 0%, transparent 50%),
        linear-gradient(145deg, #f3ead8 0%, #e4d6bc 55%, #d9c9a8 100%);
      font-family: "Courier Prime","IBM Plex Mono",Menlo,monospace; color:#2b2620;}
    .stage{position:relative;width:100%;height:100%;}
    .brand{position:absolute;left:22px;top:22px;z-index:2;}
    .brand h1{margin:0;font-family:"Iowan Old Style",Palatino,Georgia,serif;
      font-size:26px;letter-spacing:.18em;text-transform:uppercase;line-height:1;}
    .brand p{margin:6px 0 0;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#6f665b;}
    .tag{position:absolute;left:22px;bottom:22px;z-index:2;font-size:11px;color:#6f665b;letter-spacing:.04em;max-width:150px;line-height:1.35;}
    .receipt-slot{position:absolute;right:-6px;top:8px;width:250px;height:300px;transform:rotate(3.5deg);
      filter:drop-shadow(0 14px 22px rgba(40,25,5,.32));}
  </style></head><body><div class="stage">
    <div class="brand"><h1>Paper Trail</h1><p>find · synonyms · hot spots</p></div>
    <div class="tag">Many words.<br>Their synonyms.<br>Where they meet.</div>
    <div class="receipt-slot" id="slot"></div>
  </div></body></html>`, { waitUntil: 'networkidle0' });

  // Inject a self-contained mini-receipt (no extension needed for the tile)
  await tile.evaluate(() => {
    const slot = document.getElementById('slot');
    const paper = `
      <div style="
        background:#f6f1e6;
        background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.018) 0 1px,transparent 1px 3px);
        color:#2b2620;font:11.5px/1.4 'Courier Prime',Menlo,monospace;
        padding:14px 14px 10px;width:220px;box-sizing:border-box;
        -webkit-mask:
          radial-gradient(circle at 5px 0,transparent 4px,#000 4.5px) -5px 0/10px 100% repeat-x,
          radial-gradient(circle at 5px 100%,transparent 4px,#000 4.5px) -5px 0/10px 100% repeat-x,
          linear-gradient(#000,#000);
        -webkit-mask-composite:source-in;
        mask-composite:intersect;
      ">
        <div style="text-align:center;font-family:Georgia,serif;font-weight:700;font-size:13px;letter-spacing:.2em;text-transform:uppercase;">PAPER TRAIL</div>
        <div style="text-align:center;font-size:8.5px;letter-spacing:.18em;color:#6f665b;margin:2px 0 6px;">FIND · SYNONYMS · HOT SPOTS</div>
        <div style="border-top:1px dashed #b9ae9c;margin:6px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:8.5px;letter-spacing:.15em;color:#6f665b;text-transform:uppercase;"><span>item</span><span>qty</span></div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-top:5px;">
          <span style="width:8px;height:8px;background:rgba(214,158,26,.55);outline:1px solid #6b4c00;"></span>
          <span style="font-weight:700;flex:1;">fast</span>
          <span style="flex:1;border-bottom:1px dotted #a79c8c;"></span>
          <span>12</span>
        </div>
        <div style="margin:2px 0 0 14px;font-size:9.5px;color:#6f665b;">quick · rapid · speedy</div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-top:5px;">
          <span style="width:8px;height:8px;background:rgba(188,74,60,.45);outline:1px solid #5c1a12;"></span>
          <span style="font-weight:700;flex:1;">cheap</span>
          <span style="flex:1;border-bottom:1px dotted #a79c8c;"></span>
          <span>7</span>
        </div>
        <div style="margin:2px 0 0 14px;font-size:9.5px;color:#6f665b;">inexpensive · bargain</div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-top:5px;">
          <span style="width:8px;height:8px;background:rgba(52,128,122,.45);outline:1px solid #123d3a;"></span>
          <span style="font-weight:700;flex:1;">reliable</span>
          <span style="flex:1;border-bottom:1px dotted #a79c8c;"></span>
          <span>5</span>
        </div>
        <div style="margin:2px 0 0 14px;font-size:9.5px;color:#6f665b;">dependable · sturdy</div>
        <div style="border-top:2px solid #2b2620;margin:8px 0 4px;"></div>
        <div style="display:flex;justify-content:space-between;font-weight:700;font-size:13px;letter-spacing:.08em;"><span>TOTAL</span><span>24</span></div>
        <div style="margin:8px auto 2px;height:18px;width:70%;background:repeating-linear-gradient(90deg,#2b2620 0 1.5px,transparent 1.5px 3px,#2b2620 3px 4px,transparent 4px 6px,#2b2620 6px 9px,transparent 9px 11px);opacity:.85;"></div>
        <div style="text-align:center;font-size:8px;letter-spacing:.22em;text-transform:uppercase;color:#6f665b;margin-top:3px;">thank you for reading</div>
      </div>`;
    slot.innerHTML = paper;
  });
  const tilePath = path.join(outDir, 'small-promo-tile.png');
  await tile.screenshot({ path: tilePath, type: 'png' });
  console.log('wrote', tilePath);

  // ---------- marquee 1400×560 (optional) ----------
  const marquee = await browser.newPage();
  await marquee.setViewport({ width: 1400, height: 560, deviceScaleFactor: 1 });
  await marquee.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;width:1400px;height:560px;overflow:hidden;
      background:
        radial-gradient(ellipse at 20% 30%, #fff8ea 0%, transparent 50%),
        radial-gradient(ellipse at 90% 80%, #e8dcc4 0%, transparent 45%),
        linear-gradient(145deg, #f3ead8 0%, #e4d6bc 55%, #d9c9a8 100%);
      color:#2b2620;font-family:"Courier Prime","IBM Plex Mono",Menlo,monospace;}
    .row{display:flex;align-items:center;height:100%;padding:0 72px;gap:64px;box-sizing:border-box;}
    .copy{flex:1;}
    .copy h1{margin:0;font-family:"Iowan Old Style",Palatino,Georgia,serif;
      font-size:64px;letter-spacing:.16em;text-transform:uppercase;line-height:1;}
    .copy .sub{margin:14px 0 0;font-size:14px;letter-spacing:.28em;text-transform:uppercase;color:#6f665b;}
    .copy .tagline{margin:28px 0 0;font-size:22px;line-height:1.4;max-width:520px;color:#3a3632;}
    .receipt{transform:rotate(-2deg);filter:drop-shadow(0 18px 28px rgba(40,25,5,.35));flex:none;}
  </style></head><body>
  <div class="row">
    <div class="copy">
      <h1>Paper Trail</h1>
      <div class="sub">find · synonyms · hot spots</div>
      <p class="tagline">Find several words on a page at once — synonyms included — and jump to the spots where they appear together.</p>
    </div>
    <div class="receipt" id="slot"></div>
  </div>
  </body></html>`, { waitUntil: 'networkidle0' });
  await marquee.evaluate(() => {
    document.getElementById('slot').innerHTML = `
      <div style="
        background:#f6f1e6;
        background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.018) 0 1px,transparent 1px 3px);
        color:#2b2620;font:14px/1.45 'Courier Prime',Menlo,monospace;
        padding:22px 22px 16px;width:300px;box-sizing:border-box;
        -webkit-mask:
          radial-gradient(circle at 6px 0,transparent 5px,#000 5.5px) -6px 0/12px 100% repeat-x,
          radial-gradient(circle at 6px 100%,transparent 5px,#000 5.5px) -6px 0/12px 100% repeat-x,
          linear-gradient(#000,#000);
        -webkit-mask-composite:source-in;
        mask-composite:intersect;
      ">
        <div style="text-align:center;font-family:Georgia,serif;font-weight:700;font-size:18px;letter-spacing:.2em;text-transform:uppercase;">PAPER TRAIL</div>
        <div style="text-align:center;font-size:10px;letter-spacing:.18em;color:#6f665b;margin:3px 0 8px;">FIND · SYNONYMS · HOT SPOTS</div>
        <div style="border-top:1px dashed #b9ae9c;margin:8px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;letter-spacing:.15em;color:#6f665b;text-transform:uppercase;"><span>item</span><span>qty</span></div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:7px;">
          <span style="width:9px;height:9px;background:rgba(214,158,26,.55);outline:1px solid #6b4c00;"></span>
          <span style="font-weight:700;flex:1;">fast</span>
          <span style="flex:1;border-bottom:1px dotted #a79c8c;"></span>
          <span>12</span>
        </div>
        <div style="margin:2px 0 0 17px;font-size:11px;color:#6f665b;">quick · rapid · speedy</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:7px;">
          <span style="width:9px;height:9px;background:rgba(188,74,60,.45);outline:1px solid #5c1a12;"></span>
          <span style="font-weight:700;flex:1;">cheap</span>
          <span style="flex:1;border-bottom:1px dotted #a79c8c;"></span>
          <span>7</span>
        </div>
        <div style="margin:2px 0 0 17px;font-size:11px;color:#6f665b;">inexpensive · bargain</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:7px;">
          <span style="width:9px;height:9px;background:rgba(52,128,122,.45);outline:1px solid #123d3a;"></span>
          <span style="font-weight:700;flex:1;">reliable</span>
          <span style="flex:1;border-bottom:1px dotted #a79c8c;"></span>
          <span>5</span>
        </div>
        <div style="margin:2px 0 0 17px;font-size:11px;color:#6f665b;">dependable · sturdy</div>
        <div style="border-top:2px solid #2b2620;margin:12px 0 6px;"></div>
        <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;letter-spacing:.08em;"><span>TOTAL</span><span>24</span></div>
        <div style="margin:12px auto 4px;height:22px;width:70%;background:repeating-linear-gradient(90deg,#2b2620 0 2px,transparent 2px 4px,#2b2620 4px 5px,transparent 5px 8px,#2b2620 8px 11px,transparent 11px 13px);opacity:.85;"></div>
        <div style="text-align:center;font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:#6f665b;margin-top:4px;">thank you for reading</div>
      </div>`;
  });
  const marqueePath = path.join(outDir, 'marquee-promo-tile.png');
  await marquee.screenshot({ path: marqueePath, type: 'png' });
  console.log('wrote', marqueePath);
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
}
