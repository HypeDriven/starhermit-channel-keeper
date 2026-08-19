// Capture fixed-view screenshots of the game for visual validation.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const PORT = 8918;
const server = spawn('node', ['server.js', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});

async function shot(name, width, height, actions) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
  await actions(page);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `tests/captures/${name}.png` });
  console.log('captured', name);
  await page.close();
}

await shot('title', 1280, 800, async () => {});

await shot('game-editing', 1280, 800, async (page) => {
  await page.click('#btn-journey');
  await page.waitForSelector('#screen-game:not([hidden])');
  // carve a few cells for a partially-solved look
  const route = await page.evaluate(() => {
    const st = window.__ckTest.state();
    return { w: st.w, h: st.h };
  });
  for (const [x, y] of [[4, 2], [4, 3], [4, 4], [3, 4], [2, 4]]) {
    await page.evaluate(([cx, cy]) => window.__ckTest.carve(cx, cy), [x, y]);
  }
});

await shot('game-flowing', 1280, 800, async (page) => {
  await page.click('#btn-journey');
  await page.waitForSelector('#screen-game:not([hidden])');
  // auto-solve carve via hint route, then release
  await page.evaluate(() => {
    const st = window.__ckTest.state();
    // carve a vertical shaft under the source for the visual
    const si = st.cells.indexOf(5);
    const x = si % st.w;
    for (let y = Math.floor(si / st.w) + 1; y < st.h - 1; y++) window.__ckTest.carve(x, y);
    window.__ckTest.release();
  });
  await new Promise((r) => setTimeout(r, 2500));
});

await shot('mobile-portrait', 390, 844, async (page) => {
  await page.click('#btn-journey');
  await page.waitForSelector('#screen-game:not([hidden])');
});

await shot('mobile-landscape', 844, 390, async (page) => {
  await page.click('#btn-journey');
  await page.waitForSelector('#screen-game:not([hidden])');
});

await shot('results', 1280, 800, async (page) => {
  await page.click('#btn-play');
  await page.click('[data-mode="learn"]');
  await page.click('.level-item');
  await page.waitForSelector('#screen-game:not([hidden])');
  for (let y = 2; y <= 5; y++) await page.evaluate((yy) => window.__ckTest.carve(3, yy), y);
  await page.evaluate(() => window.__ckTest.release());
  await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 30000 });
});

await browser.close();
server.kill();
console.log('done');
