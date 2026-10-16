import { describe, expect, it, vi } from "vitest";
import { createLongConnectionManager } from "./long-connection.js";

const connection = { contractVersion: 1, connectorKey: "feishu", connectionId: "one", transport: "long_connection", appId: "cli_a94a4cb0bafadcd4", appSecretRef: { type: "secret_ref", secretId: "secret" }, authorizedUsers: [{ providerUserId: "ou_human", userId: "human" }] };
const message = { app_id: connection.appId, event_id: "ev-real-shaped", event_type: "im.message.receive_v1", create_time: "1788570000000", sender: { sender_type: "user", sender_id: { open_id: "ou_human" } }, message: { message_id: "om_test", chat_id: "oc_test", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "/verrail target create Verrail G2.7 验收" }) } };
function setup() {
  const sessions: Array<{ receive(data: unknown): Promise<void>; close: ReturnType<typeof vi.fn>; status(): string }> = [];
  const ingest = vi.fn().mockResolvedValue({ duplicate: false });
  const resolveSecret = vi.fn().mockResolvedValue("test-secret-not-for-logs");
  const manager = createLongConnectionManager({ resolveSecret, ingest, createClient: ({ receive }) => {
    const client = { receive, start: vi.fn().mockResolvedValue(undefined), close: vi.fn(), status: () => "connected" };
    sessions.push(client);
    return client;
  } });
  return { manager, sessions, ingest, resolveSecret };
}
describe("Feishu scoped long connection", () => {
  it("exposes only the requested workspace diagnostics without message content or credentials", async () => {
    const { manager, sessions } = setup();
    await manager.configure("one", { channelConnections: [connection] });
    await manager.configure("two", { channelConnections: [{ ...connection, appId: "cli_0000000000000002" }] });
    await sessions[0]!.receive({ ...message, sender: { sender_type: "user", sender_id: { open_id: "ou_unmapped" } } });
    const diagnostics = manager.workspaceHealth("one");
    expect(diagnostics).toEqual([expect.objectContaining({ workspaceId: "one", status: "connected", lastUnmappedProviderUserId: "ou_unmapped" })]);
    expect(manager.workspaceHealth("missing")).toEqual([]);
    expect(() => manager.workspaceHealth(undefined)).toThrow("Workspace scope is required");
    expect(JSON.stringify(diagnostics)).not.toContain("test-secret-not-for-logs");
    expect(JSON.stringify(diagnostics)).not.toContain("Verrail G2.7");
    manager.close();
  });
  it("normalizes SDK events and only forwards authorized direct messages", async () => {
    const { manager, sessions, ingest, resolveSecret } = setup();
    await manager.configure("workspace", { channelConnections: [connection] });
    expect(resolveSecret).toHaveBeenCalledWith(connection.appSecretRef, { companyId: "workspace", configPath: "channelConnections.0.appSecretRef" });
    await sessions[0]!.receive(message);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", event: expect.objectContaining({ providerEventId: message.event_id, intent: { kind: "create_target_draft" } }) }));
    await sessions[0]!.receive({ ...message, sender: { sender_type: "user", sender_id: { open_id: "unmapped" } } });
    await sessions[0]!.receive({ ...message, message: { ...message.message, chat_type: "group" } });
    expect(ingest).toHaveBeenCalledTimes(1);
  });
  it("closes replaced sessions, rejects stale callbacks and keeps workspaces isolated", async () => {
    const { manager, sessions, ingest } = setup();
    await manager.configure("one", { channelConnections: [connection] });
    const second = { ...connection, appId: "cli_0000000000000002" };
    await manager.configure("two", { channelConnections: [second] });
    await manager.configure("one", { channelConnections: [] });
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    await expect(sessions[0]!.receive(message)).rejects.toThrow("inactive");
    await sessions[1]!.receive({ ...message, app_id: second.appId });
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "two" }));
    manager.close();
    expect(sessions[1]!.close).toHaveBeenCalledTimes(1);
  });
  it("stops existing receivers on invalid configuration without leaking secrets", async () => {
    const { manager, sessions } = setup();
    await manager.configure("one", { channelConnections: [connection] });
    await expect(manager.configure("one", { channelConnections: [{ ...connection, appSecretRef: null }] })).rejects.toThrow();
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(manager.health())).not.toContain("test-secret-not-for-logs");
  });
  it("propagates a sanitized host failure so the provider retries instead of acknowledging data loss", async () => {
    const { manager, sessions, ingest } = setup();
    await manager.configure("one", { channelConnections: [connection] });
    ingest.mockRejectedValue(new Error("sensitive request object"));
    await expect(sessions[0]!.receive(message)).rejects.toThrow("Channel ingress failed");
    expect(JSON.stringify(manager.health())).not.toContain("sensitive request object");
    manager.close();
  });
  it("reserves an app before asynchronous setup and releases it when superseded", async () => {
    const { manager, resolveSecret, sessions } = setup();
    let resolve!: (value: string) => void;
    resolveSecret.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    const pending = manager.configure("one", { channelConnections: [connection] });
    await expect(manager.configure("two", { channelConnections: [connection] })).rejects.toThrow("Duplicate");
    await manager.configure("one", { channelConnections: [] });
    await manager.configure("two", { channelConnections: [connection] });
    resolve("obsolete-secret");
    await pending;
    expect(sessions).toHaveLength(1);
    expect(manager.health()[0]?.workspaceId).toBe("two");
    manager.close();
  });
  it("does not start a receiver after shutdown during secret resolution", async () => {
    const { manager, resolveSecret, sessions } = setup();
    let resolve!: (value: string) => void;
    resolveSecret.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    const pending = manager.configure("one", { channelConnections: [connection] });
    manager.close();
    resolve("obsolete-secret");
    await pending;
    expect(sessions).toHaveLength(0);
  });
});
