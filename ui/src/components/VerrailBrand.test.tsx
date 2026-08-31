// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VerrailBrand, VerrailLoading } from "./VerrailBrand";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("VerrailBrand", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders paired theme assets behind one accessible brand name", () => {
    act(() => root.render(<VerrailBrand variant="lockup" />));

    const brand = container.querySelector('[role="img"]');
    const images = [...container.querySelectorAll("img")];
    expect(brand?.getAttribute("aria-label")).toBe("Verrail");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/brand/verrail/lockup-dark.svg",
      "/brand/verrail/lockup-light.svg",
    ]);
    expect(images.every((image) => image.getAttribute("alt") === "")).toBe(true);
  });

  it("keeps loading status accessible while treating the mark as decorative", () => {
    act(() => root.render(<VerrailLoading />));

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading...");
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});
