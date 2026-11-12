// Localization coverage helpers (shared shape across this game's tests).

export const LOCALES = ['en-US', 'es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT', 'en-GB', 'es-ES', 'fr-CA', 'fr-BE', 'de-BE', 'en-SG', 'en-HK', 'en-BQ', 'es-CO', 'de-IT', 'fr-IT', 'es-CL', 'es-AR', 'es-EC', 'ja-JP', 'nl-BE', 'zh-SG', 'nl-NL', 'id-ID', 'vi-VN', 'de-BR', 'zh-HK', 'ms-SG', 'ta-SG', 'yue-HK', 'fi-FI', 'sv-FI', 'et-EE', 'da-DE', 'sl-IT', 'ru-FI', 'ru-EE', 'lb-BE', 'co-FR', 'eu-FR', 'ca-FR', 'oc-FR', 'fur-IT', 'ca-IT', 'oc-IT', 'ca-ES', 'eu-ES', 'gl-ES', 'su-ID', 'bew-ID', 'km-VN'];
export const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');

/** English keys used in code: T('…'), N('…') (deferred), and T(c ? '…' : '…'). */
export function codeKeys(src, extraFns = [], baseFns = ['T', 'N']) {
  const keys = new Set();
  const fns = [...baseFns, ...extraFns].join('|');
  const lit = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${fns})\(\s*(?:${lit})`, 'g'))) keys.add(unq(m[1] ?? m[2]));
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${fns})\((?:[^()'"?]|'[^'\n]*'|\([^()]*\))*\?\s*(?:${lit})\s*:\s*(?:${lit})`, 'g'))) {
    keys.add(unq(m[1] ?? m[2])); keys.add(unq(m[3] ?? m[4]));
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

/** Problems: missing translations in full locales, placeholder drift, stale or unknown keys. */
export function audit(tables, used) {
  const usedSet = new Set(used);
  const problems = [];
  for (const loc of FULL) {
    const t = tables[loc] || {};
    for (const k of usedSet) if (!Object.prototype.hasOwnProperty.call(t, k)) problems.push(`${loc} missing: ${k}`);
  }
  for (const [loc, table] of Object.entries(tables)) {
    if (!LOCALES.includes(loc)) problems.push(`unknown locale ${loc}`);
    for (const [k, v] of Object.entries(table)) {
      if (!usedSet.has(k)) { problems.push(`${loc} unused: ${k}`); continue; }
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
      if (want !== got) problems.push(`${loc} placeholders: ${k}`);
      const tagsK = (k.match(/<\/?\w+/g) || []).sort().join();
      const tagsV = (String(v).match(/<\/?\w+/g) || []).sort().join();
      if (tagsK !== tagsV) problems.push(`${loc} markup: ${k}`);
    }
  }
  for (const loc of ['en-GB', 'es-ES', 'fr-CA']) if (!tables[loc]) problems.push(`no ${loc} table`);
  return problems;
}

/** Load strings + the classic i18n.js in a sandbox; returns the game's I18N global. */
export function bootI18n(root, { strings, i18n, global }) {
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const read = (p) => readFileSync(new URL(p, root), 'utf8');
  vm.runInContext(read(strings), sandbox);
  vm.runInContext(read(i18n), sandbox);
  return { I18N: sandbox[global] };
}
