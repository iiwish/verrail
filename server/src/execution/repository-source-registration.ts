import { createHash } from "node:crypto";
import { z } from "zod";
import { repositorySourceProvenanceSchema } from "@paperclipai/shared";
export { repositorySourceProvenanceSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Human-authorized input registration, not a worker grant or Run completion. */
export async function registerRepositorySource(options: {
  source: { bundle: Buffer; baseCommit: string; contentHash: string; provenance: z.input<typeof repositorySourceProvenanceSchema> };
  principalId: string; signal: AbortSignal; recheck: () => Promise<void>;
  storage: Pick<StorageService, "putFile">;
  domainApi: Pick<VerrailDomainApiClient, "createArtifact" | "addArtifactRevision">;
}) {
  const provenance = repositorySourceProvenanceSchema.parse(options.source.provenance);
  const principalId = z.string().trim().min(1).max(200).parse(options.principalId);
  if (!Buffer.isBuffer(options.source.bundle) || !options.source.bundle.length || options.source.bundle.length > 32 * 1024 * 1024) {
    throw new Error("REPOSITORY_SOURCE_INVALID");
  }
  // Own the bytes across awaits; a caller cannot mutate the uploaded source.
  const bundle = Buffer.from(options.source.bundle);
  const sourceHash = hash(bundle);
  if (provenance.baseCommit !== options.source.baseCommit || sourceHash !== options.source.contentHash) {
    throw new Error("REPOSITORY_SOURCE_INVALID");
  }
  const check = async () => { options.signal.throwIfAborted(); await options.recheck(); options.signal.throwIfAborted(); };
  await check();
  const key = hash(JSON.stringify({ provenance, contentHash: sourceHash, principalId }));
  const base = { workspaceId: provenance.workspaceId, principalType: "user" as const, principalId, signal: options.signal };
  const register = async (body: Buffer, filename: string, title: string, kind: "code_change" | "report", suffix: string) => {
    await check();
    const contentHash = hash(body);
    const objectKey = `${provenance.workspaceId}/verrail/run-artifacts/sha256/${contentHash}`;
    const stored = await options.storage.putFile({ companyId: provenance.workspaceId,
      namespace: "verrail/run-artifacts", originalFilename: filename,
      contentType: kind === "report" ? "application/json" : "application/octet-stream", body, contentAddressed: true });
    if (stored.objectKey !== objectKey || stored.sha256 !== contentHash || stored.byteSize !== body.length) {
      throw new Error("REPOSITORY_SOURCE_UPLOAD_RECEIPT_INVALID");
    }
    await check();
    const artifact = await options.domainApi.createArtifact({ ...base, idempotencyKey: `repository-source:${key}:${suffix}:artifact`,
      input: { targetId: provenance.targetId, kind, title } });
    if (artifact.schemaVersion !== 1 || artifact.resourceType !== "artifact" || !z.string().uuid().safeParse(artifact.resourceId).success) {
      throw new Error("REPOSITORY_SOURCE_REGISTRATION_INVALID");
    }
    await check();
    const revision = await options.domainApi.addArtifactRevision({ ...base, idempotencyKey: `repository-source:${key}:${suffix}:revision`,
      input: { artifactId: artifact.resourceId, contentHash, contentRef: `storage:${objectKey}` } });
    if (revision.schemaVersion !== 1 || revision.resourceType !== "artifact_revision" || !z.string().uuid().safeParse(revision.resourceId).success) {
      throw new Error("REPOSITORY_SOURCE_REGISTRATION_INVALID");
    }
    await check();
    return { artifactId: artifact.resourceId, artifactRevisionId: revision.resourceId, contentHash };
  };
  const source = await register(bundle, "source.bundle", "Repository source", "code_change", "bundle");
  const manifest = Buffer.from(JSON.stringify({ ...provenance, source }), "utf8");
  const receipt = await register(manifest, "source-provenance.json", "Repository source provenance", "report", "provenance");
  return { ...provenance,
    source: { ...source, baseCommit: provenance.baseCommit, format: "git_bundle" as const }, provenanceArtifact: receipt };
}
