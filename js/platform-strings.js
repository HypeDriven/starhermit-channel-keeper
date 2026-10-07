// platform-strings.js — strings for the StarHermit platform UI (sign-in,
// invite link) in every required locale, picked from <html lang> with a
// fallback to the browser language and then en-US.

const EN_US = {
  signIn: 'Sign in with StarHermit',
  invite: 'Invite a friend',
  inviteCopied: 'Invite link copied — send it to a friend.',
  inviteFailed: 'Could not copy the invite link.',
  signedOut: 'Signed out of StarHermit — progress keeps saving on this device.',
  signedInAs: 'Signed in as {name}',
  lbPosting: 'Posting score to the leaderboard…',
  lbRank: 'Leaderboard rank: #{rank}',
  lbPosted: 'Score posted to the leaderboard.',
  lbNotPosted: 'Score not posted to the leaderboard.',
};
const TABLE = {
  'en-US': EN_US,
  'en-GB': { ...EN_US },
  'es-419': {
    signIn: 'Iniciar sesión con StarHermit',
    invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado: envíaselo a un amigo.',
    inviteFailed: 'No se pudo copiar el enlace de invitación.',
    signedOut: 'Sesión de StarHermit cerrada: el progreso se sigue guardando en este dispositivo.',
    signedInAs: 'Sesión iniciada como {name}',
    lbPosting: 'Enviando la puntuación a la clasificación…',
    lbRank: 'Puesto en la clasificación: #{rank}',
    lbPosted: 'Puntuación enviada a la clasificación.',
    lbNotPosted: 'La puntuación no se envió a la clasificación.',
  },
  'es-ES': {
    signIn: 'Iniciar sesión con StarHermit',
    invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado: envíaselo a un amigo.',
    inviteFailed: 'No se ha podido copiar el enlace de invitación.',
    signedOut: 'Sesión de StarHermit cerrada: el progreso se sigue guardando en este dispositivo.',
    signedInAs: 'Sesión iniciada como {name}',
    lbPosting: 'Enviando la puntuación a la clasificación…',
    lbRank: 'Puesto en la clasificación: #{rank}',
    lbPosted: 'Puntuación enviada a la clasificación.',
    lbNotPosted: 'La puntuación no se envió a la clasificación.',
  },
  'de-DE': {
    signIn: 'Mit StarHermit anmelden',
    invite: 'Freund einladen',
    inviteCopied: 'Einladungslink kopiert – schick ihn einem Freund.',
    inviteFailed: 'Der Einladungslink konnte nicht kopiert werden.',
    signedOut: 'Von StarHermit abgemeldet – der Fortschritt wird weiter auf diesem Gerät gespeichert.',
    signedInAs: 'Angemeldet als {name}',
    lbPosting: 'Punktzahl wird an die Bestenliste gesendet…',
    lbRank: 'Platz in der Bestenliste: #{rank}',
    lbPosted: 'Punktzahl an die Bestenliste gesendet.',
    lbNotPosted: 'Punktzahl wurde nicht an die Bestenliste gesendet.',
  },
  'fr-FR': {
    signIn: 'Se connecter avec StarHermit',
    invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié — envoyez-le à un ami.',
    inviteFailed: 'Impossible de copier le lien d’invitation.',
    signedOut: 'Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil.',
    signedInAs: 'Connecté en tant que {name}',
    lbPosting: 'Envoi du score au classement…',
    lbRank: 'Rang au classement : #{rank}',
    lbPosted: 'Score envoyé au classement.',
    lbNotPosted: 'Score non envoyé au classement.',
  },
  'fr-CA': {
    signIn: 'Se connecter avec StarHermit',
    invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié — envoyez-le à un ami.',
    inviteFailed: 'Impossible de copier le lien d’invitation.',
    signedOut: 'Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil.',
    signedInAs: 'Connecté en tant que {name}',
    lbPosting: 'Envoi du pointage au classement…',
    lbRank: 'Rang au classement : #{rank}',
    lbPosted: 'Pointage envoyé au classement.',
    lbNotPosted: 'Pointage non envoyé au classement.',
  },
  'pt-BR': {
    signIn: 'Entrar com StarHermit',
    invite: 'Convidar um amigo',
    inviteCopied: 'Link de convite copiado — envie para um amigo.',
    inviteFailed: 'Não foi possível copiar o link de convite.',
    signedOut: 'Você saiu do StarHermit — o progresso continua salvo neste dispositivo.',
    signedInAs: 'Conectado como {name}',
    lbPosting: 'Enviando a pontuação para o ranking…',
    lbRank: 'Posição no ranking: #{rank}',
    lbPosted: 'Pontuação enviada ao ranking.',
    lbNotPosted: 'Pontuação não enviada ao ranking.',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit',
    invite: 'Invita un amico',
    inviteCopied: 'Link di invito copiato: invialo a un amico.',
    inviteFailed: 'Impossibile copiare il link di invito.',
    signedOut: 'Disconnesso da StarHermit: i progressi restano salvati su questo dispositivo.',
    signedInAs: 'Accesso eseguito come {name}',
    lbPosting: 'Invio del punteggio alla classifica…',
    lbRank: 'Posizione in classifica: #{rank}',
    lbPosted: 'Punteggio inviato alla classifica.',
    lbNotPosted: 'Punteggio non inviato alla classifica.',
  },
};
const ALIASES = { en: 'en-US', es: 'es-ES', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

export const PLATFORM_LOCALES = Object.keys(TABLE);

export function platformStrings(lang) {
  let l = String(lang || '');
  if (!l && typeof document !== 'undefined') l = document.documentElement.lang || '';
  if (!l && typeof navigator !== 'undefined') l = navigator.language || '';
  if (TABLE[l]) return TABLE[l];
  const base = l.split('-')[0].toLowerCase();
  if (base === 'es') return TABLE[l === 'es' || /-ES$/i.test(l) ? 'es-ES' : 'es-419'];
  if (base === 'fr' && /-CA$/i.test(l)) return TABLE['fr-CA'];
  if (base === 'en' && /-(GB|UK|IE|AU|NZ)$/i.test(l)) return TABLE['en-GB'];
  return TABLE[ALIASES[base]] || EN_US;
}

export function fmtPlatform(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
}
