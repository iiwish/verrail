// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { DecisionDateChips } from "./DecisionDateChips";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DecisionDateChips", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await setLocale("en");
    localStorage.clear();
  });

  it("renders the governance date presets in the active Chinese locale", async () => {
    await setLocale("zh-CN");

    await act(async () => {
      root.render(
        <DecisionDateChips
          value="all"
          custom={{ from: null, to: null }}
          onChange={vi.fn()}
        />,
      );
    });

    const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(labels).toEqual(["全部", "今天", "昨天", "最近 7 天", "本月", "自定义"]);
    expect(container.textContent).not.toContain("Today");
    expect(container.textContent).not.toContain("Custom");
  });
});
