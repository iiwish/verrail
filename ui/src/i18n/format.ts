import { getCurrentLocale } from ".";
import type { SupportedLocale } from "./locales";

function activeLocale(locale?: SupportedLocale) {
  return locale ?? getCurrentLocale();
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale?: SupportedLocale) {
  return new Intl.NumberFormat(activeLocale(locale), options).format(value);
}

export function formatCurrency(value: number, currency: string, locale?: SupportedLocale) {
  return formatNumber(value, { style: "currency", currency }, locale);
}

export function formatDate(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
  locale?: SupportedLocale,
) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : "";
  }
  return new Intl.DateTimeFormat(activeLocale(locale), options).format(date);
}
