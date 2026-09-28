import type { ChannelIngressRequestV1 } from "@paperclipai/shared";
import { normalizedContentHash } from "@paperclipai/shared/portability-hash";
import { findConnection, normalizeLongConnectionMessage, type FeishuConnectorDependencies } from "./feishu-connector.js";

interface Client { start(): Promise<void>; close(): void; status(): string }
interface Dependencies {
  resolveSecret: FeishuConnectorDependencies["resolveSecret"];
  ingest(input: ChannelIngressRequestV1): Promise<unknown>;
  createClient(input: { appId: string; appSecret: string; receive(data: unknown): Promise<void> }): Client;
}
interface Session {
  workspaceId: string; connectionId: string; appId: string; active: boolean;
  client: Client; received: number; failed: number; inFlight: number;
  lastUnmappedProviderUserId: string | null;
}

function sessionHealth(session: Session) {
  return {
    workspaceId: session.workspaceId, connectionId: session.connectionId,
    status: session.client.status(), received: session.received, failed: session.failed,
    lastUnmappedProviderUserId: session.lastUnmappedProviderUserId,
  };
}

export function createLongConnectionManager(deps: Dependencies) {
  const sessions = new Map<string, Session[]>();
  const generations = new Map<string, number>();
  const reservedApps = new Map<string, string>();
  let closed = false;
  function stop(workspaceId: string) {
    for (const session of sessions.get(workspaceId) ?? []) {
      session.active = false;
      session.client.close();
    }
    sessions.delete(workspaceId);
    for (const [appId, owner] of reservedApps) {
      if (owner === workspaceId) reservedApps.delete(appId);
    }
  }
  return {
    async configure(workspaceId: string, config: Record<string, unknown>) {
      const generation = (generations.get(workspaceId) ?? 0) + 1;
      generations.set(workspaceId, generation);
      stop(workspaceId);
      if (closed) throw new Error("Channel receiver is inactive");
      const raw = config.channelConnections;
      if (!Array.isArray(raw) || raw.length > 20) throw new Error("Invalid channel connections");
      const selected = raw.filter((item) => item?.transport === "long_connection").map((item) => ({
        raw: item, connection: findConnection(config, item.connectionId),
      }));
      const appIds = new Set(reservedApps.keys());
      const connectionIds = new Set<string>();
      for (const { connection } of selected) {
        if (appIds.has(connection.appId) || connectionIds.has(connection.connectionId)) throw new Error("Duplicate Feishu receiver binding");
        appIds.add(connection.appId);
        connectionIds.add(connection.connectionId);
      }
      // Reserve before resolving secrets so concurrent workspace setup cannot share a receiver.
      for (const { connection } of selected) reservedApps.set(connection.appId, workspaceId);
      try {
        for (const { raw: rawConnection, connection } of selected) {
          const appSecret = await deps.resolveSecret(connection.appSecretRef, {
            companyId: workspaceId, configPath: `${connection.configPath}.appSecretRef`,
          });
          if (closed || generations.get(workspaceId) !== generation) return;
          const fingerprint = normalizedContentHash(rawConnection);
          const session: Session = {
            workspaceId, connectionId: connection.connectionId, appId: connection.appId,
            active: true, received: 0, failed: 0, inFlight: 0, lastUnmappedProviderUserId: null,
            client: deps.createClient({ appId: connection.appId, appSecret, receive: async (data) => {
              if (!session.active) throw new Error("Channel receiver is inactive");
              const event = normalizeLongConnectionMessage(data, connection.appId);
              if (event.kind !== "message" || event.conversation.type !== "direct") return;
              if (!connection.authorizedUsers.some((binding) => binding.providerUserId === event.author.providerUserId)) {
                session.lastUnmappedProviderUserId = event.author.providerUserId;
                return;
              }
              if (session.inFlight >= 16) throw new Error("Channel ingress is busy");
              session.inFlight++;
              try {
                await deps.ingest({ contractVersion: 1, workspaceId, connectionId: connection.connectionId,
                  connectorKey: connection.connectorKey, configurationFingerprint: fingerprint, event });
                session.received++;
              } catch {
                session.failed++;
                throw new Error("Channel ingress failed");
              } finally {
                session.inFlight--;
              }
            } }),
          };
          sessions.set(workspaceId, [...(sessions.get(workspaceId) ?? []), session]);
          await session.client.start();
        }
      } catch {
        if (generations.get(workspaceId) === generation) stop(workspaceId);
        throw new Error("Feishu connection setup failed");
      }
    },
    close() {
      closed = true;
      for (const workspaceId of sessions.keys()) stop(workspaceId);
      reservedApps.clear();
    },
    health() {
      return Array.from(sessions.values()).flat().map(sessionHealth);
    },
    workspaceHealth(workspaceId: unknown) {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) throw new Error("Workspace scope is required");
      return (sessions.get(workspaceId) ?? []).map(sessionHealth);
    },
  };
}
