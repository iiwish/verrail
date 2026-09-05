export const CHANNEL_CONNECTOR_CONTRACT_VERSION = 1 as const;

export type ChannelConversationType = "group" | "direct";

export interface ChannelConnectorDeclarationV1 {
  contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
  connectorKey: string;
  providerKey: string;
  webhookEndpointKey: string;
}

export interface ChannelAuthorizedUserBindingV1 {
  providerUserId: string;
  userId: string;
}

export interface ChannelConnectionBindingV1 {
  contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
  connectorKey: string;
  connectionId: string;
  authorizedUsers: ChannelAuthorizedUserBindingV1[];
  [providerConfigKey: string]: unknown;
}

export interface ChannelWebhookRequestV1 {
  contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
  workspaceId: string;
  connectionId: string;
  connectorKey: string;
  endpointKey: string;
  headers: Record<string, string | string[]>;
  rawBody: string;
  parsedBody?: unknown;
  requestId: string;
}

export interface ChannelMessageEventV1 {
  kind: "message";
  contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
  providerEventId: string;
  occurredAt: string | null;
  conversation: {
    externalConversationId: string;
    type: ChannelConversationType;
  };
  author: {
    providerUserId: string;
  };
  content: {
    kind: "text";
    text: string;
  };
  intent: { kind: "create_target_draft" } | null;
  replyContext: {
    providerMessageId: string;
  };
}

export type ChannelWebhookResultV1 =
  | {
      kind: "challenge";
      contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
      challenge: string;
    }
  | {
      kind: "ignored";
      contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
      reason: "unsupported_event" | "unsupported_content" | "bot_message";
      providerEventId: string | null;
    }
  | ChannelMessageEventV1;

export interface ChannelReplyRequestV1 {
  contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
  workspaceId: string;
  connectionId: string;
  connectorKey: string;
  replyContext: ChannelMessageEventV1["replyContext"];
  text: string;
  idempotencyKey: string;
}

export interface ChannelReplyResultV1 {
  contractVersion: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
  providerMessageId: string;
}

export interface ChannelIngressRequestV1 {
  contractVersion: 1;
  workspaceId: string;
  connectorKey: string;
  connectionId: string;
  configurationFingerprint: string;
  event: ChannelMessageEventV1;
}

export interface ChannelIngressResultV1 {
  duplicate: boolean;
  conversationId: string;
  messageId: string;
  draftId: string | null;
  replyProviderMessageId: string | null;
}
