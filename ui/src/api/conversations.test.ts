import { beforeEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./client", () => ({ api: transport }));
import { conversationsApi } from "./conversations";

beforeEach(() => vi.clearAllMocks());

it("reads only the scoped receipt without sending a command", async () => {
  await conversationsApi.getTargetDraftChannelReply("workspace/a", "conversation?b", "draft#c");
  expect(transport.get).toHaveBeenCalledWith("/workspaces/workspace%2Fa/conversations/conversation%3Fb/target-drafts/draft%23c/channel-reply");
  expect(transport.post).not.toHaveBeenCalled();
});

it("posts only a candidate message reference to the exact recovery endpoint", async () => {
  transport.post.mockResolvedValue({ status: "unknown", receiptId: "receipt-1" });
  expect(await conversationsApi.reconcileTargetDraftChannelReply("workspace/a", "conversation?b", "draft#c", "om_candidate"))
    .toEqual({ status: "unknown", receiptId: "receipt-1" });
  expect(transport.post).toHaveBeenCalledExactlyOnceWith(
    "/workspaces/workspace%2Fa/conversations/conversation%3Fb/target-drafts/draft%23c/channel-reply/reconcile",
    { providerMessageId: "om_candidate" },
  );
});
