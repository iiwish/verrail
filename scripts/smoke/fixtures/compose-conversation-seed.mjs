import { randomUUID } from "node:crypto";
import { agents, companies, companyMemberships, createDb, verrailAgentDefinitions,
  verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions,
  verrailConversations } from "/app/packages/db/dist/index.js";
import { withBuiltInAgentMarker } from "/app/server/dist/services/built-in-agent-metadata.js";

const db = createDb(process.env.DATABASE_URL, { maxConnections: 1 });
try {
  const userId = process.argv[2];
  const identity = await db.transaction(async tx => {
    const [workspace] = await tx.insert(companies).values({ id: process.argv[3] || randomUUID(), name: "Compose fixture", issuePrefix: "CMP" }).returning();
    const workspaceId = workspace.id;
    await tx.insert(companyMemberships).values({ companyId: workspaceId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    const owner = { createdByPrincipalType: "user", createdByPrincipalId: userId };
    const [agent] = await tx.insert(agents).values({ companyId: workspaceId, name: "Director", role: "ceo", status: "idle",
      adapterType: "opencode_local", metadata: withBuiltInAgentMarker(null, { key: "director", featureKeys: [] }) }).returning();
    const [definition] = await tx.insert(verrailAgentDefinitions).values({ id: randomUUID(), workspaceId,
      compatibilityAgentId: agent.id, name: "Director", ...owner }).returning();
    const [version] = await tx.insert(verrailAgentVersions).values({ id: randomUUID(), workspaceId,
      agentDefinitionId: definition.id, versionNumber: 1, runtime: "opencode", model: "fixture/test",
      prompt: "Read the conversation context before replying", contentHash: "fixture",
      supplyChain: { source: "saved_agent_configuration.v2", mode: "director_chat" }, ...owner }).returning();
    const [evaluation] = await tx.insert(verrailEvaluationRuns).values({ id: randomUUID(), workspaceId,
      candidateAgentVersionId: version.id, status: "inconclusive", safetyStatus: "not_run", ...owner }).returning();
    const [deployment] = await tx.insert(verrailDeployments).values({ id: randomUUID(), workspaceId,
      agentDefinitionId: definition.id, name: "Director", isPrimary: true, ...owner }).returning();
    await tx.insert(verrailDeploymentRevisions).values({ id: randomUUID(), workspaceId, deploymentId: deployment.id,
      revisionNumber: 1, agentVersionId: version.id, evaluationRunId: evaluation.id, state: "active", contentHash: "fixture", ...owner });
    const conversations = await tx.insert(verrailConversations).values(
      Array.from({ length: 5 }, () => ({ workspaceId, contextVersion: 17, ...owner })),
    ).returning();
    return { workspaceId, conversationId: conversations[0].id, versionId: version.id,
      capacityConversationIds: conversations.slice(1).map(conversation => conversation.id) };
  });
  process.stdout.write(JSON.stringify(identity));
} finally { await db.$client.end(); }
