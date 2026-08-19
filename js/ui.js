// Channel Keeper — DOM shell helpers: screens, overlays with focus
// management, announcements, toasts, captions. UI state is fully separate
// from simulation state: closing a drawer can never affect a match.

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const SCREENS = ['boot', 'title', 'mode', 'levels', 'game'];

export function showScreen(name) {
  for (const s of SCREENS) {
    const el = $(`#screen-${s}`);
    if (el) el.hidden = s !== name;
  }
  const active = $(`#screen-${name}`);
  if (active) {
    const h = active.querySelector('h1, h2, [tabindex]');
    if (h && name !== 'game') h.focus?.();
    if (name === 'game') $('#playfield')?.focus();
  }
}

// ---------------------------------------------------------------- overlays

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
let overlayStack = [];

export function openOverlay(id) {
  const el = $(`#${id}`);
  if (!el) return;
  overlayStack.push({ id, restore: document.activeElement });
  el.hidden = false;
  const first = el.querySelector('.btn-primary') || el.querySelector(FOCUSABLE);
  if (first) first.focus();
  el._trap = (e) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(el.querySelectorAll(FOCUSABLE)).filter((b) => !b.disabled);
    if (!items.length) return;
    const firstI = items[0], lastI = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstI) { lastI.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === lastI) { firstI.focus(); e.preventDefault(); }
  };
  el.addEventListener('keydown', el._trap);
}

export function closeOverlay(id) {
  const el = $(`#${id}`);
  if (!el || el.hidden) return;
  el.hidden = true;
  el.removeEventListener('keydown', el._trap);
  const rec = overlayStack.find((o) => o.id === id);
  overlayStack = overlayStack.filter((o) => o.id !== id);
  // Focus restoration after every modal.
  const target = rec && rec.restore && document.contains(rec.restore)
    ? rec.restore
    : (overlayStack.length ? $(`#${overlayStack[overlayStack.length - 1].id}`) : $('#playfield'));
  target?.focus?.();
}

export function anyOverlayOpen() {
  return overlayStack.length > 0;
}

export function topOverlay() {
  return overlayStack.length ? overlayStack[overlayStack.length - 1].id : null;
}

// ---------------------------------------------------------------- feedback

export function announce(text, assertive = false) {
  const el = assertive ? $('#alert') : $('#live');
  if (!el) return;
  el.textContent = '';
  // Force re-announcement of repeated text.
  requestAnimationFrame(() => { el.textContent = text; });
}

let toastTimer = null;
export function toast(text, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

let captionTimer = null;
export function caption(text) {
  const el = $('#captions');
  if (!el) return;
  el.textContent = text;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { el.textContent = ''; }, 1800);
}

export function fmtInt(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}
