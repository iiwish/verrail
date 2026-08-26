import type { Resource } from "i18next";

import { assertValidLocaleMessages } from "./locale-validation";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const DEFAULT_LOCALE = "en" as const;
export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const localeOptions: ReadonlyArray<{ code: SupportedLocale; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
];

export const localeMessages: Record<SupportedLocale, unknown> = {
  en,
  "zh-CN": zhCN,
};

for (const [locale, messages] of Object.entries(localeMessages)) {
  try {
    assertValidLocaleMessages(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${locale} locale messages: ${message}`);
  }
}

export const supportedLocales: SupportedLocale[] = [...SUPPORTED_LOCALES];

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, messages]) => [locale, { translation: messages }]),
) as Resource;

export function normalizeLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}
