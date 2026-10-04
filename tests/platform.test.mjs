// platform.test.mjs — js/platform.js over starhermit-sdk.js with a stubbed
// fetch and launch fragment: token read, profile nickname, cloud save
// round-trip on game:<slug>, settings KV, bindings, and no network at all
// when standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHosted, installStandalone, UID } from './starhermit-harness.mjs';

const SLUG = 'channel-keeper';

test('hosted: token, profile, cloud save game:<slug>, settings, bindings, invite', async () => {
  const { sdk, env, win } = installHosted(SLUG);
  const { platform } = await import('../js/platform.js');
  assert.equal(sdk.userId, UID);
  assert.ok(!/game_token/.test(win.history.url || ''));
  await platform.init();
  assert.ok(platform.hosted);
  assert.equal(platform.slug, SLUG);
  assert.equal((await platform.fetchProfile()).name, 'Ada');

  assert.equal(await platform.loadCloud(), null);
  platform.saveCloud({ progress: { stars: 3 } });
  assert.equal(await platform.flushSave(), true);
  const put = env.calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/cloud-saves/game%3Achannel-keeper'), put.url);
  assert.deepEqual(await platform.loadCloud(), { progress: { stars: 3 } });
  assert.equal(platform.sync, 'synced');

  assert.deepEqual(await platform.getSettings(), {}); // only known preference keys pass
  platform.mirrorSettings({ volMusic: 0.1, tutorialsDone: ['x'] });
  await new Promise((r) => setTimeout(r, 900));
  const patch = env.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.init.body).settings, { volMusic: 0.1 });

  await platform.loadBindings();
  assert.equal(platform.actionFor({ code: 'KeyW' }), 'up');
  assert.equal(platform.actionFor({ code: 'Space' }), 'carve');
  assert.equal(platform.keyLabel('release'), 'R');
  assert.equal(platform.inviteLink(), `https://dashboard.starhermit.com/game-invite/${UID}/${SLUG}`);
  assert.equal(platform.canSignIn(), false);
});

test('standalone: no token, no network', async () => {
  const st = installStandalone();
  try {
    const { platform } = await import('../js/platform.js');
    await platform.init();
    assert.equal(platform.hosted, false);
    assert.equal(await platform.syncTime(), false);
    assert.equal(await platform.loadCloud(), null);
    await platform.saveCloud({});
    await platform.flushSave();
    assert.deepEqual(await platform.getSettings(), {});
    platform.mirrorSettings({ volMusic: 1 });
    await platform.loadBindings();
    assert.equal(platform.actionFor({ code: 'KeyR' }), 'release');
    assert.deepEqual(await platform.submitDaily('d', {}), { ok: false, reason: 'offline' });
    assert.equal(platform.inviteLink(), null);
    assert.deepEqual(st.calls, []);
  } finally { st.restore(); }
});
