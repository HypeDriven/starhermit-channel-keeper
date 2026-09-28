// Channel Keeper — strings for the Graphics settings section. The rest of the
// game ships in English; this panel follows navigator.language.

const EN = {
  legend: 'Graphics',
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  cat_shadows: 'Shadows', cat_ao: 'Ambient occlusion', cat_bloom: 'Bloom', cat_grade: 'Color grade',
  cat_antialias: 'Anti-aliasing', cat_particles: 'Particles', cat_background: 'Background',
  cat_detail: 'Surface detail', cat_water: 'Water',
  t_off: 'Off', t_on: 'On', t_low: 'Low', t_medium: 'Medium', t_high: 'High',
  t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Static', t_animated: 'Animated',
  t_plain: 'Plain', t_detailed: 'Detailed', t_flat: 'Flat',
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device; effects are rendered without it.',
  noWebgl: 'WebGL is unavailable: the board uses the plain button grid.',
  w_noShadows: 'no shadows', w_shadows: 'shadows', w_ao: 'ambient occlusion',
  w_aoHigh: 'full ambient occlusion', w_bloom: 'bloom', w_noAA: 'no anti-aliasing',
};

const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, cat_grade: 'Colour grade', showFps: 'Show frame rate' },
  'es-419': {
    legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor', cat_grade: 'Corrección de color',
    cat_antialias: 'Antialiasing', cat_particles: 'Partículas', cat_background: 'Fondo',
    cat_detail: 'Detalle de superficies', cat_water: 'Agua',
    t_off: 'No', t_on: 'Sí', t_low: 'Baja', t_medium: 'Media', t_high: 'Alta',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Estático', t_animated: 'Animado',
    t_plain: 'Simple', t_detailed: 'Detallado', t_flat: 'Plana',
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; se dibuja sin efectos.',
    noWebgl: 'WebGL no está disponible: el tablero usa la cuadrícula de botones.',
    w_noShadows: 'sin sombras', w_shadows: 'sombras', w_ao: 'oclusión ambiental',
    w_aoHigh: 'oclusión ambiental completa', w_bloom: 'resplandor', w_noAA: 'sin antialiasing',
  },
  'es-ES': {
    legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el preajuste ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor', cat_grade: 'Etalonaje',
    cat_antialias: 'Suavizado de bordes', cat_particles: 'Partículas', cat_background: 'Fondo',
    cat_detail: 'Detalle de superficies', cat_water: 'Agua',
    t_off: 'No', t_on: 'Sí', t_low: 'Baja', t_medium: 'Media', t_high: 'Alta',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Estático', t_animated: 'Animado',
    t_plain: 'Sencillo', t_detailed: 'Detallado', t_flat: 'Plana',
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar imágenes por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; se dibuja sin efectos.',
    noWebgl: 'WebGL no está disponible: el tablero usa la cuadrícula de botones.',
    w_noShadows: 'sin sombras', w_shadows: 'sombras', w_ao: 'oclusión ambiental',
    w_aoHigh: 'oclusión ambiental completa', w_bloom: 'resplandor', w_noAA: 'sin suavizado',
  },
  'de-DE': {
    legend: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
    renderScale: 'Renderskalierung', fromPreset: 'Aus Voreinstellung ({tier})',
    cat_shadows: 'Schatten', cat_ao: 'Umgebungsverdeckung', cat_bloom: 'Leuchteffekt', cat_grade: 'Farbkorrektur',
    cat_antialias: 'Kantenglättung', cat_particles: 'Partikel', cat_background: 'Hintergrund',
    cat_detail: 'Oberflächendetails', cat_water: 'Wasser',
    t_off: 'Aus', t_on: 'Ein', t_low: 'Niedrig', t_medium: 'Mittel', t_high: 'Hoch',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Statisch', t_animated: 'Animiert',
    t_plain: 'Einfach', t_detailed: 'Detailliert', t_flat: 'Flach',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne Effekte gerendert.',
    noWebgl: 'WebGL ist nicht verfügbar: Das Spielfeld nutzt das einfache Tastenraster.',
    w_noShadows: 'keine Schatten', w_shadows: 'Schatten', w_ao: 'Umgebungsverdeckung',
    w_aoHigh: 'volle Umgebungsverdeckung', w_bloom: 'Leuchteffekt', w_noAA: 'keine Kantenglättung',
  },
  'fr-FR': {
    legend: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})',
    low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Halo lumineux', cat_grade: 'Étalonnage',
    cat_antialias: 'Anticrénelage', cat_particles: 'Particules', cat_background: 'Arrière-plan',
    cat_detail: 'Détail des surfaces', cat_water: 'Eau',
    t_off: 'Non', t_on: 'Oui', t_low: 'Basse', t_medium: 'Moyenne', t_high: 'Haute',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Statique', t_animated: 'Animé',
    t_plain: 'Simple', t_detailed: 'Détaillé', t_flat: 'Plate',
    adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postFailed: 'Le post-traitement est indisponible sur cet appareil ; le rendu se fait sans effets.',
    noWebgl: 'WebGL est indisponible : le plateau utilise la grille de boutons.',
    w_noShadows: 'sans ombres', w_shadows: 'ombres', w_ao: 'occlusion ambiante',
    w_aoHigh: 'occlusion ambiante complète', w_bloom: 'halo', w_noAA: 'sans anticrénelage',
  },
  'pt-BR': {
    legend: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusão de ambiente', cat_bloom: 'Brilho', cat_grade: 'Correção de cor',
    cat_antialias: 'Antisserrilhado', cat_particles: 'Partículas', cat_background: 'Fundo',
    cat_detail: 'Detalhe das superfícies', cat_water: 'Água',
    t_off: 'Desligado', t_on: 'Ligado', t_low: 'Baixa', t_medium: 'Média', t_high: 'Alta',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Estático', t_animated: 'Animado',
    t_plain: 'Simples', t_detailed: 'Detalhado', t_flat: 'Plana',
    adaptive: 'Resolução adaptativa', showFps: 'Mostrar quadros por segundo',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; a imagem é desenhada sem ele.',
    noWebgl: 'WebGL indisponível: o tabuleiro usa a grade de botões.',
    w_noShadows: 'sem sombras', w_shadows: 'sombras', w_ao: 'oclusão de ambiente',
    w_aoHigh: 'oclusão de ambiente completa', w_bloom: 'brilho', w_noAA: 'sem antisserrilhado',
  },
  'it-IT': {
    legend: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({tier})',
    cat_shadows: 'Ombre', cat_ao: 'Occlusione ambientale', cat_bloom: 'Bagliore', cat_grade: 'Correzione colore',
    cat_antialias: 'Antialiasing', cat_particles: 'Particelle', cat_background: 'Sfondo',
    cat_detail: 'Dettaglio superfici', cat_water: 'Acqua',
    t_off: 'No', t_on: 'Sì', t_low: 'Bassa', t_medium: 'Media', t_high: 'Alta',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Statico', t_animated: 'Animato',
    t_plain: 'Semplice', t_detailed: 'Dettagliato', t_flat: 'Piatta',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra fotogrammi al secondo',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il rendering avviene senza effetti.',
    noWebgl: 'WebGL non disponibile: il tabellone usa la griglia di pulsanti.',
    w_noShadows: 'senza ombre', w_shadows: 'ombre', w_ao: 'occlusione ambientale',
    w_aoHigh: 'occlusione ambientale completa', w_bloom: 'bagliore', w_noAA: 'senza antialiasing',
  },
};
STRINGS['fr-CA'] = {
  ...STRINGS['fr-FR'],
  quality: 'Qualité', cat_antialias: 'Antialiasing', w_noAA: 'sans antialiasing',
  showFps: 'Afficher le nombre d’images par seconde',
};

export const GFX_LOCALES = Object.keys(STRINGS);

/** Pick the closest supported locale for a BCP 47 tag (default en-US). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = GFX_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.slice(0, 2).toLowerCase();
  const region = t.split(/[-_]/)[1]?.toUpperCase();
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'IN', 'ZA'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

/** Translator for one locale; `{tier}` placeholders are filled from `vars`. */
export function gfxStrings(locale) {
  const table = { ...EN, ...(STRINGS[locale] || {}) };
  return (key, vars) => String(table[key] ?? EN[key] ?? key)
    .replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? vars[k] : ''));
}

export function missingKeys(locale) {
  return Object.keys(EN).filter((k) => !(STRINGS[locale] && k in STRINGS[locale]));
}
