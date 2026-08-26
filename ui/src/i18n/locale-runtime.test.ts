// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { getCurrentLocale, setLocale } from ".";
import { LOCALE_STORAGE_KEY } from "./locale-preference";

describe("locale runtime", () => {
  afterEach(async () => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    await setLocale("en");
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  });

  it("changes language immediately, persists it, and updates html lang", async () => {
    await setLocale("zh-CN");

    expect(getCurrentLocale()).toBe("zh-CN");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
