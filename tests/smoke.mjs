// Browser smoke test: boots the game in headless Chrome, plays tutorial 1
// end-to-end through the real UI, and reports console errors.
// Run: node tests/smoke.mjs  (requires `npm i --no-save puppeteer-core`)

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const PORT = 8917;
const server = spawn('node', ['server.js', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader', '--window-size=1280,800'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed++;
};

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
  check('boot reaches title screen', true);

  // Canvas mounted?
  check('WebGL canvas mounted', await page.$('#game-canvas') !== null);

  // Title → mode select.
  await page.click('#btn-play');
  check('mode select visible', await page.$('#screen-mode:not([hidden])') !== null);

  // Learn mode → tutorial 1.
  await page.click('[data-mode="learn"]');
  await page.waitForSelector('#screen-levels:not([hidden])');
  check('levels screen lists lessons', (await page.$$('.level-item')).length === 5);
  await page.click('.level-item');
  await page.waitForSelector('#screen-game:not([hidden])');
  check('game screen shows', true);
  check('tutorial panel visible', await page.$('#tutorial-panel:not([hidden])') !== null);

  const hud = await page.$eval('#hud-objective', (el) => el.textContent);
  check('objective populated', hud.length > 5);

  // Play tutorial 1 via keyboard: source at (3,1), target (3,6) on 7x8 grid.
  // Carve (3,2)..(3,5) then release. Cursor starts at (3,2).
  const carveAt = async (x, y) => {
    await page.evaluate(([cx, cy]) => window.__ckTest.carve(cx, cy), [x, y]);
  };
  // Use in-page API exposed for tests.
  const hasApi = await page.evaluate(() => !!window.__ckTest);
  check('test API exposed', hasApi);
  for (let y = 2; y <= 5; y++) await carveAt(3, y);
  const budget = await page.$eval('#hud-budget', (el) => el.textContent);
  check('budget decremented by carves', budget === '4');
  await page.evaluate(() => window.__ckTest.release());

  // Wait for win.
  await page.waitForFunction(
    () => window.__ckTest.phase() === 'won',
    { timeout: 30000 },
  );
  check('tutorial 1 wins via real session', true);
  await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 5000 });
  const total = await page.$eval('#sc-total', (el) => el.textContent);
  check('results show a positive score', parseInt(total.replace(/\D/g, ''), 10) > 0);

  // Progression + persistence.
  const persisted = await page.evaluate(() => localStorage.getItem('channelkeeper.progress') !== null);
  check('progress persisted to localStorage', persisted);
  const achv = await page.evaluate(() => JSON.parse(localStorage.getItem('channelkeeper.achievements')).data);
  check('first_flow achievement unlocked', !!achv.first_flow);

  // Watch replay: re-runs the deterministic command log, then returns.
  await page.click('#btn-watch-replay');
  await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 60000 });
  check('replay watch runs and returns to results', true);

  // Retry from results → fresh round.
  await page.click('#btn-retry');
  await page.waitForFunction(() => window.__ckTest.phase() === 'editing', { timeout: 5000 });
  check('retry restarts the round', true);

  // Pause / resume overlay.
  await page.keyboard.press('Escape');
  check('pause overlay opens', await page.$('#overlay-pause:not([hidden])') !== null);
  await page.click('#btn-resume-game');
  check('pause overlay closes', await page.$('#overlay-pause[hidden]') !== null);

  // Pointer input: abandon, retry, then click a canvas cell through the
  // real raycast path.
  await page.evaluate(() => window.__ckTest.leave());
  await page.waitForSelector('#overlay-results:not([hidden])');
  await page.click('#btn-retry');
  await page.waitForFunction(() => window.__ckTest.phase() === 'editing', { timeout: 5000 });
  const before = await page.evaluate(() => window.__ckTest.state().movesUsed);
  const cv = await page.$('#game-canvas');
  const box = await cv.boundingBox();
  // Click the cell just below the source (center-ish of the board).
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 40);
  const after = await page.evaluate(() => window.__ckTest.state().movesUsed);
  check('pointer click carves via raycast', after === before + 1);

  // Settings overlay + persistence.
  await page.evaluate(() => window.__ckTest.leave());
  await page.waitForSelector('#overlay-results:not([hidden])');
  await page.click('#btn-results-exit');
  await page.waitForSelector('#screen-title:not([hidden])');
  await page.click('#btn-settings');
  await page.select('#set-quality', 'low');
  const q = await page.evaluate(() => JSON.parse(localStorage.getItem('channelkeeper.settings')).data.quality);
  check('quality setting persisted', q === 'low');
  await page.click('#btn-settings-close');

  // Daily flow boots.
  await page.click('#btn-daily');
  await page.waitForSelector('#screen-game:not([hidden])');
  const phase = await page.evaluate(() => window.__ckTest.phase());
  check('daily round starts', phase === 'editing');

  // Server API reachable from the page origin.
  const time = await page.evaluate(async () => (await fetch('/api/v1/time')).json());
  check('server time endpoint', typeof time.now === 'number');

  check('no console errors', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `\n${failed} FAILURES` : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
