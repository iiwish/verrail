import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { verrailConversationInvocations, verrailConversationInvocationEvents } from "./schema/verrail_conversation_invocations.js";

describe("conversation invocation storage", () => {
  it("serializes active work per conversation and deduplicates per principal", () => {
    const config = getTableConfig(verrailConversationInvocations);
    const active = config.indexes.find(index => index.config.name === "verrail_chat_invocations_active_uq");
    expect(active?.config.unique).toBe(true);
    expect(active?.config.where).toBeDefined();
    expect(active?.config.columns.map(column => (column as { name: string }).name)).toEqual(["workspace_id", "conversation_id"]);
    const key = config.indexes.find(index => index.config.name === "verrail_chat_invocations_request_uq");
    expect(key?.config.columns.map(column => (column as { name: string }).name)).toEqual(["workspace_id", "principal_id", "idempotency_key"]);
  });

  it("binds source messages and fixed versions using composite workspace keys", () => {
    const keys = getTableConfig(verrailConversationInvocations).foreignKeys.map(key => key.reference().columns.map(column => column.name));
    expect(keys).toContainEqual(["source_message_id", "conversation_id", "workspace_id"]);
    expect(keys).toContainEqual(["deployment_revision_id", "agent_version_id", "workspace_id"]);
  });

  it("stores replay cursors once per invocation and keeps scoped events", () => {
    const config = getTableConfig(verrailConversationInvocationEvents);
    expect(config.indexes.find(index => index.config.name === "verrail_chat_invocation_events_cursor_uq")?.config.unique).toBe(true);
    expect(config.foreignKeys.map(key => key.reference().columns.map(column => column.name))).toContainEqual(["invocation_id", "workspace_id"]);
  });
});
