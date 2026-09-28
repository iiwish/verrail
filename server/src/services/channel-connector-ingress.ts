import type { ChannelIngressResultV1, ChannelReplyRequestV1 } from "@paperclipai/shared";
import { channelConnectionBindingV1Schema, channelIngressRequestV1Schema, channelReplyResultV1Schema } from "@paperclipai/shared";
import { normalizedContentHash } from "@paperclipai/shared/portability-hash";
import { forbidden } from "../errors.js";
import type { channelConnectorHostService } from "./channel-connector-host.js";

interface Dependencies {
  getPlugin(): Promise<{ status: string; manifestJson: { channelConnectors?: Array<{ contractVersion: number; connectorKey: string }> } | null } | null>;
  getConfig(workspaceId: string): Promise<Record<string, unknown>>;
  ingest: ReturnType<typeof channelConnectorHostService>["ingest"];
  recordReply: ReturnType<typeof channelConnectorHostService>["recordReply"];
  sendReply(input: ChannelReplyRequestV1): Promise<unknown>;
}

export function createChannelConnectorIngress(deps: Dependencies) {
  return async (rawInput: unknown): Promise<ChannelIngressResultV1> => {
    const input = channelIngressRequestV1Schema.parse(rawInput);
    const plugin = await deps.getPlugin();
    if (plugin?.status !== "ready" || !plugin.manifestJson?.channelConnectors?.some(
      (item) => item.contractVersion === 1 && item.connectorKey === input.connectorKey,
    )) throw forbidden("Channel connector is not ready or declared");
    const config = await deps.getConfig(input.workspaceId);
    const rawConnections = config.channelConnections;
    const raw = Array.isArray(rawConnections) ? rawConnections.find((item) => item?.connectionId === input.connectionId) : null;
    const parsed = channelConnectionBindingV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.connectorKey !== input.connectorKey
      || parsed.data.transport !== "long_connection"
      || normalizedContentHash(raw) !== input.configurationFingerprint) {
      throw forbidden("Channel connection configuration is missing or stale");
    }
    const connection = parsed.data;
    if (input.event.conversation.type !== "direct" || !connection.authorizedUsers.some(
      (binding) => binding.providerUserId === input.event.author.providerUserId,
    )) throw forbidden("Channel message is outside the authorized direct conversation scope");

    const result = await deps.ingest({ ...input, connection });
    if (result.draftId && !result.replyProviderMessageId) {
      const reply = channelReplyResultV1Schema.parse(await deps.sendReply({
        contractVersion: 1, workspaceId: input.workspaceId, connectorKey: input.connectorKey,
        connectionId: input.connectionId, replyContext: input.event.replyContext,
        text: `Verrail: Target draft ${result.draftId} is ready to continue in Verrail.`,
        idempotencyKey: `verrail:${result.draftId}`,
      }));
      await deps.recordReply({
        workspaceId: input.workspaceId, connectorKey: input.connectorKey,
        connectionId: input.connectionId, providerEventId: input.event.providerEventId,
        providerMessageId: reply.providerMessageId,
      });
      result.replyProviderMessageId = reply.providerMessageId;
    }
    return result;
  };
}
