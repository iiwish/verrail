import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  type Db, companies, companySecrets, companySecretVersions, companySecretProviderConfigs,
  verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions,
  verrailGithubRepoBindings, toolConnections,
} from "@paperclipai/db";
import { conflict } from "../errors.js";

export interface GitHubCiCollectionContext {
  workspaceId: string; targetId: string; targetRevisionId: string; graphRevisionId: string;
  connectionId: string; bindingId: string; repository: string; contextSha256: string;
}

function unavailable(): never { throw conflict("GitHub CI collection context unavailable or changed"); }

/** A short read-only snapshot; no transaction is held during credentials or HTTP. */
export async function loadGitHubCiCollectionContext(db: Db, workspaceId: string, targetId: string): Promise<GitHubCiCollectionContext> {
  return db.transaction(async tx => {
    const [row] = await tx.select({
      workspaceId: verrailTargets.workspaceId, targetId: verrailTargets.id,
      targetRevisionId: verrailTargetRevisions.id, targetHash: verrailTargetRevisions.contentHash,
      targetStatus: verrailTargets.status, targetUpdatedAt: verrailTargets.updatedAt,
      graphRevisionId: verrailGraphRevisions.id, graphHash: verrailGraphRevisions.contentHash,
      graphUpdatedAt: verrailWorkGraphs.updatedAt, graphStatus: verrailWorkGraphs.status,
      graphActivatedAt: verrailGraphRevisions.activatedAt,
      bindingId: verrailGithubRepoBindings.id, bindingCreatedAt: verrailGithubRepoBindings.createdAt,
      repoOwner: verrailGithubRepoBindings.repoOwner, repoName: verrailGithubRepoBindings.repoName,
      connectionId: toolConnections.id, connectionUpdatedAt: toolConnections.updatedAt,
      authKind: toolConnections.authKind, transport: toolConnections.transport, credentialRefs: toolConnections.credentialRefs,
      credentialSecretRefs: toolConnections.credentialSecretRefs,
    }).from(verrailTargets)
      .innerJoin(companies, and(eq(companies.id, verrailTargets.workspaceId), eq(companies.status, "active")))
      .innerJoin(verrailTargetRevisions, and(eq(verrailTargetRevisions.id, verrailTargets.activeTargetRevisionId), eq(verrailTargetRevisions.workspaceId, workspaceId), eq(verrailTargetRevisions.targetId, targetId)))
      .innerJoin(verrailWorkGraphs, and(eq(verrailWorkGraphs.targetId, targetId), eq(verrailWorkGraphs.workspaceId, workspaceId)))
      .innerJoin(verrailGraphRevisions, and(eq(verrailGraphRevisions.id, verrailWorkGraphs.activeGraphRevisionId), eq(verrailGraphRevisions.workGraphId, verrailWorkGraphs.id), eq(verrailGraphRevisions.workspaceId, workspaceId), eq(verrailGraphRevisions.targetId, targetId), eq(verrailGraphRevisions.targetRevisionId, verrailTargetRevisions.id), eq(verrailGraphRevisions.status, "active")))
      .innerJoin(verrailGithubRepoBindings, eq(verrailGithubRepoBindings.workspaceId, workspaceId))
      .innerJoin(toolConnections, and(eq(toolConnections.id, verrailGithubRepoBindings.connectionId), eq(toolConnections.companyId, workspaceId), eq(toolConnections.enabled, true), eq(toolConnections.status, "active")))
      .where(and(eq(verrailTargets.id, targetId), eq(verrailTargets.workspaceId, workspaceId))).limit(1);
    if (!row || !["oauth", "api_key"].includes(row.authKind) || row.targetStatus === "canceled" || row.graphStatus === "canceled") unavailable();
    if (row.credentialRefs.length > 32 || row.credentialSecretRefs.length > 32) unavailable();
    // Match the existing resolver's priority without ever selecting secret material.
    const header = row.credentialRefs.find(ref => ref.placement === "header" && ref.key.toLowerCase() === "authorization");
    const token = ["oauth.access_token", "credentials.token", "github.token", "access_token", "token"]
      .map(path => row.credentialSecretRefs.find(ref => ref.configPath === path)).find(ref => ref !== undefined);
    const selected = header ? { id: header.secretId, version: header.version ?? "latest" }
      : token ? { id: token.secretId, version: token.versionSelector ?? "latest" } : null;
    if (!selected) unavailable();
    const [secret] = await tx.select({
      id: companySecrets.id, scope: companySecrets.scope, status: companySecrets.status,
      provider: companySecrets.provider, providerConfigId: companySecrets.providerConfigId,
      externalRef: companySecrets.externalRef, managedMode: companySecrets.managedMode,
      latestVersion: companySecrets.latestVersion, lastRotatedAt: companySecrets.lastRotatedAt,
    }).from(companySecrets).where(and(eq(companySecrets.id, selected.id), eq(companySecrets.companyId, workspaceId), isNull(companySecrets.deletedAt))).limit(1);
    if (!secret || secret.scope !== "company" || secret.status !== "active") unavailable();
    const [version] = await tx.select({
      id: companySecretVersions.id, version: companySecretVersions.version,
      status: companySecretVersions.status, revokedAt: companySecretVersions.revokedAt,
      providerVersionRef: companySecretVersions.providerVersionRef,
    }).from(companySecretVersions).where(and(eq(companySecretVersions.secretId, secret.id), eq(companySecretVersions.version, selected.version === "latest" ? secret.latestVersion : selected.version))).limit(1);
    if (!version || version.revokedAt || ["disabled", "destroyed"].includes(version.status)) unavailable();
    const configs = await tx.select({ id: companySecretProviderConfigs.id, status: companySecretProviderConfigs.status,
      updatedAt: companySecretProviderConfigs.updatedAt, disabledAt: companySecretProviderConfigs.disabledAt,
    }).from(companySecretProviderConfigs).where(and(eq(companySecretProviderConfigs.companyId, workspaceId), eq(companySecretProviderConfigs.provider, secret.provider),
      secret.providerConfigId ? eq(companySecretProviderConfigs.id, secret.providerConfigId) : eq(companySecretProviderConfigs.isDefault, true))).limit(2);
    if (configs.length > 1 || (secret.providerConfigId && configs.length !== 1)
      || configs.some(c => c.disabledAt || c.status !== "ready")) unavailable();
    // Secret updatedAt/lastResolvedAt change on every legitimate resolution. Fingerprint
    // only security metadata instead, including latestVersion and revocation state.
    const contextSha256 = createHash("sha256").update(JSON.stringify({ row, secret, version, configs })).digest("hex");
    return { workspaceId, targetId, targetRevisionId: row.targetRevisionId, graphRevisionId: row.graphRevisionId,
      connectionId: row.connectionId, bindingId: row.bindingId, repository: `${row.repoOwner}/${row.repoName}`, contextSha256 };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
