// Seeded deterministic random streams for Channel Keeper.
// Rules, content decoration, and audiovisual variants each use separate streams
// so cosmetic randomness can never change rules outcomes.

/** Hash a string to a 32-bit unsigned seed (FNV-1a). */
export function hashString(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Combine a numeric seed with a stream namespace string. */
export function streamSeed(seed, stream) {
  return (hashString(String(stream)) ^ (seed >>> 0)) >>> 0;
}

/** mulberry32 PRNG — small, fast, deterministic. */
export function makeRng(seed, stream = 'default') {
  let a = streamSeed(seed, stream) >>> 0;
  const rng = {
    /** Float in [0, 1). */
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** Integer in [min, max] inclusive. */
    int(min, max) {
      return min + Math.floor(rng.next() * (max - min + 1));
    },
    /** Random element of an array. */
    pick(arr) {
      return arr[Math.floor(rng.next() * arr.length)];
    },
    /** True with probability p. */
    chance(p) {
      return rng.next() < p;
    },
    /** In-place Fisher–Yates shuffle (deterministic). */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
    /** Current internal state, for save/resume. */
    state() { return a >>> 0; },
  };
  return rng;
}
