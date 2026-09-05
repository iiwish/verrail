import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  createDb,
  verrailChannelEvents,
  verrailConversationMessages,
  verrailConversations,
  verrailProviderConversationBindings,
  verrailTargetCreationDrafts,
} from "@paperclipai/db";
import type { ChannelConnectionBindingV1, ChannelMessageEventV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { channelConnectorHostService } from "../services/channel-connector-host.js";

const support = await getEmbeddedPostgresTestSupport();
const externalDatabaseUrl = process.env.VERRAIL_CHANNEL_TEST_DATABASE_URL;
const describePostgres = support.supported || externalDatabaseUrl ? describe : describe.skip;

function connection(connectionId = "feishu-primary"): ChannelConnectionBindingV1 {
  return {
    contractVersion: 1,
    connectorKey: "feishu",
    connectionId,
    authorizedUsers: [{ providerUserId: "ou_human", userId: "local-human" }],
  };
}

function event(overrides: Partial<ChannelMessageEventV1> = {}): ChannelMessageEventV1 {
  return {
    kind: "message",
    contractVersion: 1,
    providerEventId: "evt-1",
    occurredAt: "2026-09-04T09:00:00.000Z",
    conversation: { externalConversationId: "oc_group", type: "group" },
    author: { providerUserId: "ou_human" },
    content: { kind: "text", text: "/verrail target create" },
    intent: { kind: "create_target_draft" },
    replyContext: { providerMessageId: "om_1" },
    ...overrides,
  };
}

describePostgres("channelConnectorHostService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      db = createDb(externalDatabaseUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-channel-host-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(verrailChannelEvents);
    await db.delete(verrailTargetCreationDrafts);
    await db.delete(verrailConversationMessages);
    await db.delete(verrailProviderConversationBindings);
    await db.delete(verrailConversations);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function workspace(name = "Channel Workspace") {
    const issuePrefix = name === "First" ? "FST" : name === "Second" ? "SND" : "CHN";
    const row = await db.insert(companies).values({ name, issuePrefix }).returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: row.id,
      principalType: "user",
      principalId: "local-human",
      status: "active",
      membershipRole: "owner",
    });
    return row;
  }

  it("creates one recoverable draft and converges concurrent provider replay", async () => {
    const current = await workspace();
    const service = channelConnectorHostService(db);
    const input = {
      workspaceId: current.id,
      connectorKey: "feishu",
      connectionId: "feishu-primary",
      connection: connection(),
      event: event(),
    };

    const results = await Promise.all([service.ingest(input), service.ingest(input)]);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(await db.select().from(verrailChannelEvents)).toHaveLength(1);
    expect(await db.select().from(verrailConversationMessages)).toHaveLength(1);
    expect(await db.select().from(verrailTargetCreationDrafts)).toEqual([
      expect.objectContaining({
        status: "collecting",
        initiatedByPrincipalId: "local-human",
        sourceMessageId: results[0]!.messageId,
      }),
    ]);

    const first = results.find((result) => !result.duplicate)!;
    await service.recordReply({
      workspaceId: current.id,
      connectorKey: "feishu",
      connectionId: "feishu-primary",
      providerEventId: "evt-1",
      providerMessageId: "om_reply",
    });
    await expect(service.ingest(input)).resolves.toMatchObject({
      duplicate: true,
      draftId: first.draftId,
      replyProviderMessageId: "om_reply",
    });
  });

  it("keeps an ordinary unmapped direct message in Conversation only", async () => {
    const current = await workspace();
    const result = await channelConnectorHostService(db).ingest({
      workspaceId: current.id,
      connectorKey: "feishu",
      connectionId: "feishu-primary",
      connection: connection(),
      event: event({
        providerEventId: "evt-direct",
        conversation: { externalConversationId: "oc_direct", type: "direct" },
        author: { providerUserId: "ou_guest" },
        content: { kind: "text", text: "ordinary message" },
        intent: null,
      }),
    });
    expect(result).toMatchObject({ duplicate: false, draftId: null, authorizedUserId: null });
    expect(await db.select().from(verrailTargetCreationDrafts)).toEqual([]);
    expect(await db.select().from(verrailConversationMessages)).toEqual([
      expect.objectContaining({ body: "ordinary message", authorPrincipalId: "provider:feishu:ou_guest" }),
    ]);
  });

  it("rejects explicit creation by an unmapped or inactive human", async () => {
    const current = await workspace();
    await expect(channelConnectorHostService(db).ingest({
      workspaceId: current.id,
      connectorKey: "feishu",
      connectionId: "feishu-primary",
      connection: connection(),
      event: event({ author: { providerUserId: "ou_guest" } }),
    })).rejects.toMatchObject({ status: 403, details: { code: "CHANNEL_USER_NOT_AUTHORIZED" } });
    expect(await db.select().from(verrailChannelEvents)).toEqual([]);

    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, current.id));
    await expect(channelConnectorHostService(db).ingest({
      workspaceId: current.id,
      connectorKey: "feishu",
      connectionId: "feishu-primary",
      connection: connection(),
      event: event(),
    })).rejects.toMatchObject({ status: 403, details: { code: "CHANNEL_USER_MEMBERSHIP_INACTIVE" } });
  });

  it("rejects connection scope substitution and separates Workspaces", async () => {
    const first = await workspace("First");
    const second = await workspace("Second");
    const service = channelConnectorHostService(db);
    await expect(service.ingest({
      workspaceId: first.id,
      connectorKey: "feishu",
      connectionId: "substituted",
      connection: connection(),
      event: event(),
    })).rejects.toMatchObject({ status: 422, details: { code: "CHANNEL_CONNECTION_SCOPE_MISMATCH" } });

    const [one, two] = await Promise.all([
      service.ingest({
        workspaceId: first.id,
        connectorKey: "feishu",
        connectionId: "feishu-primary",
        connection: connection(),
        event: event(),
      }),
      service.ingest({
        workspaceId: second.id,
        connectorKey: "feishu",
        connectionId: "feishu-primary",
        connection: connection(),
        event: event(),
      }),
    ]);
    expect(one.conversationId).not.toBe(two.conversationId);
    expect(await db.select().from(verrailProviderConversationBindings)).toHaveLength(2);
  });

  it("checks active membership for ordinary long-connection messages before persisting", async () => {
    const current = await workspace();
    const service = channelConnectorHostService(db);
    const input = {
      workspaceId: current.id, connectorKey: "feishu", connectionId: "feishu-primary",
      connection: { ...connection(), transport: "long_connection" as const },
      event: event({ intent: null, content: { kind: "text", text: "ordinary private message" },
        conversation: { type: "direct", externalConversationId: "oc_direct" } }),
    };
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, current.id));
    await expect(service.ingest(input)).rejects.toMatchObject({ status: 403, details: { code: "CHANNEL_USER_MEMBERSHIP_INACTIVE" } });
    expect(await db.select().from(verrailChannelEvents)).toEqual([]);
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.companyId, current.id));
    await expect(service.ingest(input)).resolves.toMatchObject({ draftId: null, authorizedUserId: "local-human" });
    expect(await db.select().from(verrailConversationMessages)).toHaveLength(1);
  });
});
