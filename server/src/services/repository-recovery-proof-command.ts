import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { assertDeliveryProofReader, type DeliveryProofReaderAccess } from "./delivery-proof-reader-access.js";
import { deliveryProofTrustSchema, type DeliveryProofRecorderConfig } from "./delivery-proof-recorder.js";
import { openCodeRuntimeDigest, openCodeRuntimeManifestSchema } from "./opencode-runtime-observation.js";
import { repositoryRecoverySelectionSchema } from "./repository-recovery-proof-context.js";
import { authorizeRepositoryRecovery, authorizeRepositoryRecoveryCompletion, authorizeRepositoryRecoveryProbes } from "./repository-recovery-proof-reader.js";

const after = z.object({ targetId: z.string().uuid(), targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(),
  claimId: z.string().uuid(), workNodeId: z.string().uuid(), artifactRevisionId: z.string().uuid(), requirementId: z.string().min(1).max(200) }).strict();
export const repositoryRecoveryReaderCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recovery-authorize"), references: repositoryRecoverySelectionSchema.omit({ workspaceId: true }) }).strict(),
  z.object({ kind: z.literal("recovery-probe-authorize"), references: after, oldAttemptId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("recovery-complete-authorize"), references: after }).strict(),
]);

/** Private CLI capability: fixed operations only; no caller supplied filesystem paths, keys or observed facts. */
export async function runRepositoryRecoveryReaderCommand(db: Db, access: DeliveryProofReaderAccess, raw: unknown,
  config: DeliveryProofRecorderConfig, storage: Pick<StorageService, "getObject">) {
  const input = repositoryRecoveryReaderCommandSchema.parse(raw), trust = deliveryProofTrustSchema.parse(config.trust);
  const authority = await assertDeliveryProofReader(db, access), manifest = openCodeRuntimeManifestSchema.parse(config.runtime.manifest);
  const privateKey = createPrivateKey(config.privateKey), publicKey = createPublicKey(privateKey);
  if (access.schemaVersion !== 4 || !config.recovery || authority.policySha256 !== trust.readerPolicySha256
    || access.workspaceId !== trust.ci.workspaceId || config.runtime.manifestSha256 !== trust.runtimeManifestSha256
    || openCodeRuntimeDigest(manifest) !== config.runtime.manifestSha256 || manifest.candidateCommit !== trust.ci.workflowExecutionSha
    || privateKey.asymmetricKeyType !== "ed25519" || publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") !== trust.publicKey) {
    throw new Error("REPOSITORY_RECOVERY_COMMAND_UNAVAILABLE");
  }
  const references = { ...input.references, workspaceId: access.workspaceId };
  for (const key of ["targetId", "targetRevisionId", "graphRevisionId"] as const) {
    if (references[key] !== trust.ci[key]) throw new Error("REPOSITORY_RECOVERY_COMMAND_UNAVAILABLE");
  }
  const options = { storage, repository: { repository: trust.ci.repository, connectionId: trust.ci.connectionId, bindingId: trust.ci.bindingId },
    config: { ...config.recovery, runtime: { ...config.runtime, manifest }, readerPrivateKey: config.privateKey } };
  if (input.kind === "recovery-authorize") return authorizeRepositoryRecovery(db, access, { ...input.references, workspaceId: access.workspaceId }, options);
  if (input.kind === "recovery-probe-authorize") return authorizeRepositoryRecoveryProbes(db, access, { ...input.references, workspaceId: access.workspaceId }, input.oldAttemptId, options);
  return authorizeRepositoryRecoveryCompletion(db, access, { ...input.references, workspaceId: access.workspaceId }, options);
}
