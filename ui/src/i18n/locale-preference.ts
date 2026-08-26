import { DEFAULT_LOCALE, normalizeLocale, type SupportedLocale } from "./locales";

export const LOCALE_STORAGE_KEY = "verrail.locale";

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;

function getBrowserStorage(): LocaleStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function getBrowserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [];
}

export function readLocalePreference(storage: LocaleStorage | null = getBrowserStorage()): SupportedLocale | null {
  if (!storage) return null;
  try {
    return normalizeLocale(storage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function detectBrowserLocale(languages: readonly string[] = getBrowserLanguages()): SupportedLocale | null {
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return null;
}

export function resolveInitialLocale(options: {
  storage?: LocaleStorage | null;
  languages?: readonly string[];
} = {}): SupportedLocale {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const languages = options.languages === undefined ? getBrowserLanguages() : options.languages;
  return readLocalePreference(storage) ?? detectBrowserLocale(languages) ?? DEFAULT_LOCALE;
}

export function writeLocalePreference(
  locale: SupportedLocale,
  storage: LocaleStorage | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}
