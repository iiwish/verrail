// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, setLocale } from "@/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("localized overlay controls", () => {
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

  it("uses the active locale for Dialog close controls and keeps Escape dismissal", async () => {
    await setLocale("zh-CN");
    const onOpenChange = vi.fn();

    await act(async () => {
      root.render(
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>标题</DialogTitle>
            <DialogDescription>说明</DialogDescription>
            <DialogFooter showCloseButton />
          </DialogContent>
        </Dialog>,
      );
    });

    const closeControls = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).filter(
      (control) => control.textContent?.trim() === "Close" || control.textContent?.trim() === "关闭",
    );
    expect(closeControls).toHaveLength(2);
    expect(closeControls.every((control) => control.textContent?.trim() === "关闭")).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses the active locale for the Sheet close control", async () => {
    await setLocale("zh-CN");

    await act(async () => {
      root.render(
        <Sheet open>
          <SheetContent>
            <SheetTitle>标题</SheetTitle>
            <SheetDescription>说明</SheetDescription>
          </SheetContent>
        </Sheet>,
      );
    });

    const closeControl = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (control) => control.textContent?.trim() === "Close" || control.textContent?.trim() === "关闭",
    );
    expect(closeControl?.textContent?.trim()).toBe("关闭");
    expect(i18n.resolvedLanguage).toBe("zh-CN");
  });
});
