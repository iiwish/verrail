// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TargetRepositorySource } from "./TargetRepositorySource";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("@/api/targets", () => ({ targetsApi: { prepareRepositorySource: prepare } }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

it("aborts acquisition on unmount and never accepts its late receipt", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onPrepared = vi.fn();
  const onBusy = vi.fn();
  let resolve!: (value: unknown) => void;
  prepare.mockImplementation(() => new Promise(done => { resolve = done; }));
  let unmounted = false;
  try {
    await act(async () => root.render(<TargetRepositorySource workspaceId="workspace" targetId="target"
      targetRevisionId="revision" graphRevisionId="graph" onPrepared={onPrepared} onBusy={onBusy} />));
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "main");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("button")!.click());
    const signal = prepare.mock.calls[0][3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => root.unmount());
    unmounted = true;
    expect(signal.aborted).toBe(true);
    onPrepared.mockClear(); onBusy.mockClear();
    await act(async () => resolve({ workspaceId: "workspace", targetId: "target", targetRevisionId: "revision", graphRevisionId: "graph" }));
    expect(onPrepared).not.toHaveBeenCalled();
    expect(onBusy).not.toHaveBeenCalled();
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    container.remove(); prepare.mockReset();
  }
});
