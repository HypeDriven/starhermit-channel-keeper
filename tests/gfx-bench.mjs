// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the real Settings
// overlay, starts Learn lesson 1 and loops carve → release → retry with real keys/buttons, so the
// flowing water shimmer, splashes, environment and the post chain all run.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#overlay-settings:not([hidden])');
  await page.locator('#set-quality').scrollIntoViewIfNeeded();
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForSelector('#overlay-settings[hidden]', { state: 'attached' });
}

async function round(page, mobile) {
  await page.locator('#playfield').focus();
  for (const k of ['Enter', 'Enter', 'ArrowDown', 'Enter', 'ArrowDown', 'Enter']) await page.keyboard.press(k);
  if (mobile) await page.click('#tray-release', { timeout: 1000 }); else await page.keyboard.press('r');
  await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(400);
  await page.click('#btn-retry', { timeout: 2000 });
  await page.waitForSelector('#overlay-results[hidden]', { state: 'attached', timeout: 5000 });
}

export async function start(page, { mobile } = {}) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-mode:not([hidden])');
  await page.click('[data-mode="learn"]');
  await page.waitForSelector('#screen-levels:not([hidden])');
  await page.locator('.level-item').first().click();
  await page.waitForSelector('#screen-game:not([hidden])');
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await round(page, mobile); } catch { if (!open) return; await page.waitForTimeout(200).catch(() => {}); }
    }
  })();
  await page.waitForTimeout(1500);
}
