// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invocationQueryKey, useConversationInvocation } from "./useConversationInvocation";

const api = vi.hoisted(() => ({ invocations: vi.fn(), cancelInvocation: vi.fn() }));
vi.mock("../api/conversations", () => ({ conversationsApi: api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const row = { id: "invocation", workspaceId: "workspace", conversationId: "conversation", output: "Saved", status: "running", lastEventCursor: 2, finishedAt: null };
class Source extends EventTarget {
  static instances: Source[] = [];
  close = vi.fn();
  constructor(public url: string) { super(); Source.instances.push(this); }
}
let value: ReturnType<typeof useConversationInvocation>;
function Harness() { value = useConversationInvocation("workspace", "conversation", true); return <div>{value.active?.output}</div>; }
let root: ReturnType<typeof createRoot> | undefined;
let client: QueryClient;
let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); client?.clear(); container?.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); Source.instances = []; });
async function mount() {
  vi.stubGlobal("EventSource", Source);
  api.invocations.mockResolvedValue([row]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
describe("durable conversation subscription", () => {
  it("restores saved output, deduplicates replay and disconnects without cancelling", async () => {
    await mount();
    const source = Source.instances[0];
    expect(source.url).toContain("after=2");
    expect(container.textContent).toBe("Saved");
    await act(async () => {
      for (let i = 0; i < 2; i++) source.dispatchEvent(new MessageEvent("chunk", { data: JSON.stringify({ text: " reply" }), lastEventId: "3" }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe("Saved reply");
    await act(async () => { await client.refetchQueries({ queryKey: invocationQueryKey("workspace", "conversation") }); });
    expect(container.textContent).toBe("Saved reply");
    await act(async () => root!.unmount());
    root = undefined;
    expect(source.close).toHaveBeenCalled();
    expect(api.cancelInvocation).not.toHaveBeenCalled();
  });
  it("sends explicit cancellation and keeps the invocation pending cleanup", async () => {
    await mount();
    await act(async () => {
      Source.instances[0].dispatchEvent(new MessageEvent("chunk", { data: JSON.stringify({ text: " reply" }), lastEventId: "3" }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    api.cancelInvocation.mockResolvedValue({ ...row, status: "cancel_requested" });
    await act(async () => { await value.cancel.mutateAsync(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(api.cancelInvocation).toHaveBeenCalledWith("workspace", "conversation", "invocation");
    expect(value.active?.status).toBe("cancel_requested");
    expect(value.active?.finishedAt).toBeNull();
    expect(value.active?.output).toBe("Saved reply");
  });
});
