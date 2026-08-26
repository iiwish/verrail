import { describe, expect, it } from "vitest";

import { formatCurrency, formatDate, formatNumber } from "./format";

describe("locale formatting", () => {
  it("formats numbers for the selected locale", () => {
    expect(formatNumber(12345.6, undefined, "en")).toBe("12,345.6");
    expect(formatNumber(12345.6, undefined, "zh-CN")).toBe("12,345.6");
  });

  it("formats dates and currencies through Intl", () => {
    expect(formatDate(new Date("2026-08-25T00:00:00Z"), { timeZone: "UTC", dateStyle: "long" }, "en"))
      .toBe("August 25, 2026");
    expect(formatCurrency(42, "USD", "en")).toContain("42.00");
  });

  it("preserves invalid date strings without throwing", () => {
    expect(formatDate("not-a-date", undefined, "en")).toBe("not-a-date");
    expect(formatDate(new Date(Number.NaN), undefined, "zh-CN")).toBe("");
  });
});
