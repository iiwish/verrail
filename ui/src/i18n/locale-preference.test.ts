import { describe, expect, it, vi } from "vitest";

import {
  LOCALE_STORAGE_KEY,
  detectBrowserLocale,
  readLocalePreference,
  resolveInitialLocale,
  writeLocalePreference,
} from "./locale-preference";
import { normalizeLocale } from "./locales";

describe("locale preference", () => {
  it("normalizes supported English and Chinese browser locales", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("zh_SG")).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-CN");
    expect(normalizeLocale("fr-FR")).toBeNull();
  });

  it("uses the first supported browser language", () => {
    expect(detectBrowserLocale(["fr-FR", "zh-HK", "en-US"])).toBe("zh-CN");
    expect(detectBrowserLocale(["fr-FR", "de-DE"])).toBeNull();
  });

  it("prefers persisted locale and falls back to browser then English", () => {
    const storage = { getItem: vi.fn(() => "en"), setItem: vi.fn() };
    expect(resolveInitialLocale({ storage, languages: ["zh-CN"] })).toBe("en");

    storage.getItem.mockReturnValue("not-a-locale");
    expect(resolveInitialLocale({ storage, languages: ["zh-CN"] })).toBe("zh-CN");
    expect(resolveInitialLocale({ storage, languages: ["fr-FR"] })).toBe("en");
  });

  it("survives inaccessible storage", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    expect(readLocalePreference(storage)).toBeNull();
    expect(writeLocalePreference("zh-CN", storage)).toBe(false);
  });

  it("persists canonical locale values", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    expect(writeLocalePreference("zh-CN", storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "zh-CN");
  });
});
