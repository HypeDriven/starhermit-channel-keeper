/**
 * Channel Keeper — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → settings → mode select → Learn lesson 1 ("First Dig") →
 *   carve a channel with the keyboard (arrows + Enter) → release water →
 *   results screen → watch replay (desktop) → retry → pause/resume →
 *   pointer carve on the canvas → leave round → back to title.
 *
 * The game is fully playable offline (all StarHermit API calls from the
 * client are fire-and-forget with offline fallbacks), so this test serves
 * the static files itself on an ephemeral port and stubs the trivial
 * beacon/time endpoints.
 *
 * Game state (window.__ckTest.phase()/state()) is read only for
 * synchronization/assertions; every action goes through real UI input.
 *
 * Two passes: desktop 1280x800, then mobile 390x844 with touch.
 * Run: npm run test:e2e
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOT = (stage, pass) => `/tmp/channel-keeper-e2e-${stage}-${pass}.png`;

// Benign GPU/swiftshader noise (from tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'video/mp2t',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Minimal stubs for the client's fire-and-forget platform calls.
  if (url.pathname === '/api/v1/time') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ now: Date.now() }));
  }
  if (url.pathname === '/api/v1/events' || url.pathname === '/api/v1/presence') {
    res.writeHead(202, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  try {
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) throw new Error('forbidden');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

async function runPass(label, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${label}] ${name}`);
  };
  const phase = () => page.evaluate(() => window.__ckTest?.phase());

  try {
    await step('load reaches title screen', async () => {
      await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
      await page.screenshot({ path: SHOT('title', label) });
    });

    await step('settings opens, quality persists, closes', async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#overlay-settings:not([hidden])');
      await page.selectOption('#set-quality', 'low');
      const q = await page.evaluate(
        () => JSON.parse(localStorage.getItem('channelkeeper.settings')).data.quality,
      );
      if (q !== 'low') throw new Error(`quality not persisted, got ${q}`);
      await page.screenshot({ path: SHOT('settings', label) });
      await page.click('#btn-settings-close');
      await page.waitForSelector('#overlay-settings[hidden]', { state: 'attached', timeout: 5000 });
    });

    await step('play → learn mode → lesson list', async () => {
      await page.click('#btn-play');
      await page.waitForSelector('#screen-mode:not([hidden])');
      await page.click('[data-mode="learn"]');
      await page.waitForSelector('#screen-levels:not([hidden])');
      const lessons = await page.locator('.level-item').count();
      if (lessons !== 5) throw new Error(`expected 5 lessons, got ${lessons}`);
      await page.screenshot({ path: SHOT('levels', label) });
    });

    await step('lesson 1 starts with tutorial panel', async () => {
      await page.locator('.level-item').first().click();
      await page.waitForSelector('#screen-game:not([hidden])');
      await page.waitForSelector('#tutorial-panel:not([hidden])');
      const hud = await page.textContent('#hud-objective');
      if (!hud || hud.length < 5) throw new Error('objective not populated');
      if ((await phase()) !== 'editing') throw new Error(`expected editing phase, got ${await phase()}`);
      await page.screenshot({ path: SHOT('game', label) });
    });

    // Tutorial 1 "First Dig": 7x8 board, spring at (3,1), well at (3,6).
    // Cursor starts one row below the spring at (3,2); carving advances the
    // tutorial, which re-focuses the cursor one cell lower each step.
    await step('carve channel with real keyboard input', async () => {
      await page.locator('#playfield').focus(); // board is a focusable application widget
      const keys = ['Enter', 'Enter', 'ArrowDown', 'Enter', 'ArrowDown', 'Enter'];
      for (const k of keys) await page.keyboard.press(k);
      const budget = (await page.textContent('#hud-budget')).trim();
      if (budget !== '4') throw new Error(`expected budget 4 after 4 carves, got ${budget}`);
      const st = await page.evaluate(() => window.__ckTest.state());
      if (st.movesUsed !== 4) throw new Error(`expected 4 moves, got ${st.movesUsed}`);
      await page.screenshot({ path: SHOT('carved', label) });
    });

    await step('release water → win → results screen', async () => {
      if (label === 'mobile') await page.click('#tray-release');
      else await page.keyboard.press('r');
      await page.waitForFunction(() => window.__ckTest.phase() === 'won', null, { timeout: 30000 });
      await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 5000 });
      const total = await page.textContent('#sc-total');
      if (!(parseInt(total.replace(/\D/g, ''), 10) > 0)) throw new Error(`bad total score: ${total}`);
      await page.screenshot({ path: SHOT('results', label) });
    });

    await step('progress persisted to localStorage', async () => {
      const prog = await page.evaluate(() => localStorage.getItem('channelkeeper.progress'));
      if (!prog) throw new Error('no progress in localStorage');
      const achv = await page.evaluate(
        () => JSON.parse(localStorage.getItem('channelkeeper.achievements')).data,
      );
      if (!achv.first_flow) throw new Error('first_flow achievement missing');
    });

    if (label === 'desktop') {
      await step('watch replay returns to results', async () => {
        await page.click('#btn-watch-replay');
        await page.waitForSelector('#overlay-results[hidden]', { state: 'attached', timeout: 5000 });
        await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 60000 });
      });
    }

    await step('retry restarts the round', async () => {
      await page.click('#btn-retry');
      await page.waitForFunction(() => window.__ckTest.phase() === 'editing', null, { timeout: 5000 });
    });

    await step('pause and resume', async () => {
      if (label === 'mobile') await page.click('#tray-pause');
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not([hidden])');
      await page.screenshot({ path: SHOT('pause', label) });
      await page.click('#btn-resume-game');
      await page.waitForSelector('#overlay-pause[hidden]', { state: 'attached' });
    });

    await step('pointer click on canvas carves via raycast', async () => {
      const before = await page.evaluate(() => window.__ckTest.state().movesUsed);
      const box = await page.locator('#game-canvas').boundingBox();
      if (!box) throw new Error('canvas not visible');
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2 - 40;
      if (label === 'mobile') await page.touchscreen.tap(cx, cy);
      else await page.mouse.click(cx, cy);
      await page.waitForFunction(
        (b) => window.__ckTest.state().movesUsed >= b, before, { timeout: 5000 },
      );
    });

    await step('leave round → results → back to title', async () => {
      if (label === 'mobile') await page.click('#tray-pause');
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not([hidden])');
      await page.click('#btn-pause-leave');
      await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 5000 });
      await page.click('#btn-results-exit');
      await page.waitForSelector('#screen-title:not([hidden])');
      await page.screenshot({ path: SHOT('back-to-title', label) });
    });
  } finally {
    if (errors.length) {
      console.error(`\n[${label}] non-benign console/page errors:\n${errors.join('\n')}`);
    }
    await context.close();
    if (errors.length) throw new Error(`[${label}] ${errors.length} console/page error(s)`);
  }
}

try {
  await runPass('desktop', { viewport: { width: 1280, height: 800 } });
  await runPass('mobile', { viewport: { width: 390, height: 844 }, hasTouch: true });
} finally {
  await browser.close();
  server.close();
}
console.log('\nE2E OK — both desktop and mobile passes completed clean');
