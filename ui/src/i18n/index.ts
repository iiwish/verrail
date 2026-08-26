import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { resolveInitialLocale, writeLocalePreference } from "./locale-preference";
import {
  DEFAULT_LOCALE,
  i18nextResources,
  normalizeLocale,
  supportedLocales,
  type SupportedLocale,
} from "./locales";

const initialLocale = resolveInitialLocale();

function updateDocumentLanguage(locale: SupportedLocale) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

updateDocumentLanguage(initialLocale);

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

i18n.on("languageChanged", (language) => {
  updateDocumentLanguage(normalizeLocale(language) ?? DEFAULT_LOCALE);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export function getCurrentLocale(): SupportedLocale {
  return normalizeLocale(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LOCALE;
}

export async function setLocale(locale: SupportedLocale) {
  writeLocalePreference(locale);
  await i18n.changeLanguage(locale);
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
