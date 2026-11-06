// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's: the nine StarHermit locales, English text as the key;
// en-GB, es-ES and fr-CA hold their differences, the chain reads the rest) in
// the interface language the runtime reports (the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// account lines are the engine's `starhermit.*` keys.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function tr(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key translated with tr() where it is shown. */
export const N = (s: string): string => s;
