import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailCriterionProofs, verrailIntegrationRuns, verrailIntegrationAttempts, verrailEvidence,
  verrailVerificationResults, verrailArtifactRevisions, verrailAgentCommandReceipts, verrailAuditEvents,
  verrailTargetRevisions } from "@paperclipai/db";
import { githubFixedCiProofCommandSchema, githubFixedCiProofTrustSchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { conflict } from "../errors.js";
import { loadGitHubCiSourceContext } from "./github-ci-source-context.js";

const version = "github-fixed-ci-verifier.v1";
const principal = "github-fixed-ci-verifier";
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
// Match the domain service's canonical JSON, including Go's HTML escaping.
const proofDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)
  .replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)).digest("hex");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function unavailable(): never { throw conflict("Codex artifact and CI context unavailable or changed"); }
const receiptSchema = z.object({ kind: z.literal("verrail.fixed-ci-proof"), schemaVersion: z.literal(1),
  verifierVersion: z.literal(version), trustProfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  trustProfile: githubFixedCiProofTrustSchema, input: githubFixedCiProofCommandSchema,
  criterionProof: z.object({ contractHash: z.string().regex(/^[a-f0-9]{64}$/), requirementId: z.string(), assertions: z.array(z.string()),
    targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(), commitRef: z.string(), verifiedAt: z.string(),
    providerRunId: z.string(), providerAttempt: z.number() }).strict(),
}).strict();

/** Links existing admitted records; this does not admit proof or re-fetch GitHub. */
export async function loadCodexArtifactCiContext(db: Db, input: {
  workspaceId: string; targetId: string; targetRevisionId: string; graphRevisionId: string;
  runId: string; runAttemptId: string; artifactRevisionId: string; fixedCiProofId: string;
}, native: { runEventId: string; runEventContentHash: string; outputReceiptSha256: string }) {
  const { workspaceId, targetId, targetRevisionId, graphRevisionId } = input;
  const records = await db.transaction(async tx => {
    const rows = await tx.select({ proof: verrailCriterionProofs, integration: verrailIntegrationRuns,
      evidence: verrailEvidence, verification: verrailVerificationResults, artifact: verrailArtifactRevisions,
      revision: verrailTargetRevisions }).from(verrailCriterionProofs)
      .innerJoin(verrailIntegrationRuns, and(eq(verrailIntegrationRuns.id, verrailCriterionProofs.integrationRunId), eq(verrailIntegrationRuns.workspaceId, workspaceId)))
      .innerJoin(verrailEvidence, and(eq(verrailEvidence.id, verrailIntegrationRuns.evidenceId), eq(verrailEvidence.workspaceId, workspaceId)))
      .innerJoin(verrailVerificationResults, and(eq(verrailVerificationResults.id, verrailCriterionProofs.verificationResultId), eq(verrailVerificationResults.workspaceId, workspaceId)))
      .innerJoin(verrailArtifactRevisions, and(eq(verrailArtifactRevisions.id, input.artifactRevisionId), eq(verrailArtifactRevisions.workspaceId, workspaceId)))
      .innerJoin(verrailTargetRevisions, and(eq(verrailTargetRevisions.id, targetRevisionId), eq(verrailTargetRevisions.workspaceId, workspaceId)))
      .where(and(eq(verrailCriterionProofs.id, input.fixedCiProofId), eq(verrailCriterionProofs.workspaceId, workspaceId))).limit(2);
    const row = rows[0];
    if (rows.length !== 1 || !row) unavailable();
    const { proof, integration, evidence, verification, artifact, revision } = row;
    const parsed = receiptSchema.safeParse(integration.providerReceipt);
    if (!parsed.success) unavailable();
    const receipt = parsed.data, command = receipt.input, trust = receipt.trustProfile;
    const externalRef = `https://github.com/${trust.repository}/actions/runs/${command.ci.providerRunId}/attempts/${command.ci.providerAttempt}`;
    if ([proof, integration].some(record => record.targetId !== targetId || record.targetRevisionId !== targetRevisionId || record.graphRevisionId !== graphRevisionId)
      || revision.targetId !== targetId || proof.phase !== "pre_acceptance" || proof.submissionId !== null || proof.effectReceiptId !== null
      || integration.provider !== "github" || integration.connectorVersion !== version || integration.conclusion !== "success"
      || integration.createdByPrincipalType !== "service" || integration.createdByPrincipalId !== principal
      || integration.verificationResultId !== verification.id || verification.verdict !== "passed" || verification.verifierVersion !== version
      || verification.targetId !== targetId || verification.claimId !== integration.claimId || !same(verification.evidenceIds, [evidence.id])
      || verification.createdByPrincipalType !== "service" || verification.createdByPrincipalId !== principal
      || evidence.targetId !== targetId || evidence.claimId !== integration.claimId || evidence.kind !== "ci_result" || evidence.trustLevel !== "high"
      || evidence.producerPrincipalType !== "service" || evidence.producerPrincipalId !== principal || evidence.objectHash !== artifact.contentHash
      || evidence.reference !== externalRef || integration.externalRef !== externalRef || integration.commitRef !== command.ci.testedCommit
      || integration.environmentRef !== `github:${trust.repository}:${command.ci.testedCommit}`
      || command.targetId !== targetId || command.targetRevisionId !== targetRevisionId || command.graphRevisionId !== graphRevisionId
      || command.claimId !== integration.claimId || command.workNodeId !== integration.workNodeId || command.artifactRevisionId !== artifact.id
      || command.criterionKey !== proof.criterionKey || command.criterionKey !== integration.criterionKey || command.requirementId !== proof.requirementId
      || trust.workspaceId !== workspaceId || trust.targetId !== targetId || trust.targetRevisionId !== targetRevisionId || trust.graphRevisionId !== graphRevisionId
      || trust.connectionId !== integration.connectionId || trust.workflowExecutionSha !== command.ci.testedCommit || digest(trust) !== receipt.trustProfileSha256) unavailable();
    const criterion = revision.acceptanceCriteria.filter(entry => entry.id === proof.criterionKey);
    const contract = criterion[0]?.proofContract;
    const requirements = contract?.allOf.filter(entry => entry.id === proof.requirementId) ?? [];
    const requirement = requirements[0];
    if (!contract || criterion.length !== 1 || requirements.length !== 1 || requirement?.kind !== "independent_verification"
      || requirement.phase !== "pre_acceptance" || proofDigest(contract) !== proof.contractHash
      || proofDigest({ input: command, trustProfileSha256: receipt.trustProfileSha256 }) !== proof.sourcePayloadHash
      || !same(receipt.criterionProof, { contractHash: proof.contractHash, requirementId: proof.requirementId, assertions: requirement.assertions,
        targetRevisionId, graphRevisionId, commitRef: integration.commitRef, verifiedAt: command.ci.verifiedAt,
        providerRunId: command.ci.providerRunId, providerAttempt: command.ci.providerAttempt })) unavailable();
    const verifiedAt = Date.parse(command.ci.verifiedAt), admittedAt = integration.createdAt.getTime();
    if (verifiedAt > admittedAt + 60000 || verifiedAt < admittedAt - trust.maxAgeMs) unavailable();
    const attempts = await tx.select().from(verrailIntegrationAttempts).where(and(eq(verrailIntegrationAttempts.workspaceId, workspaceId), eq(verrailIntegrationAttempts.integrationRunId, integration.id))).limit(2);
    const attempt = attempts[0];
    if (attempts.length !== 1 || !attempt || attempt.attemptNumber !== 1 || attempt.status !== "succeeded" || attempt.connectorVersion !== version
      || attempt.connectionId !== integration.connectionId || attempt.providerRef !== externalRef || attempt.idempotencyKey !== integration.idempotencyKey
      || !same(attempt.providerReceipt, receipt)) unavailable();
    const commands = await tx.select().from(verrailAgentCommandReceipts).where(and(eq(verrailAgentCommandReceipts.workspaceId, workspaceId),
      eq(verrailAgentCommandReceipts.principalType, "service"), eq(verrailAgentCommandReceipts.principalId, principal),
      eq(verrailAgentCommandReceipts.commandType, "github.fixed_ci_proof.record.v1"), eq(verrailAgentCommandReceipts.idempotencyKey, integration.idempotencyKey))).limit(2);
    const audit = await tx.select().from(verrailAuditEvents).where(and(eq(verrailAuditEvents.workspaceId, workspaceId), eq(verrailAuditEvents.aggregateId, integration.id),
      eq(verrailAuditEvents.aggregateType, "integration_run"), eq(verrailAuditEvents.eventType, "connector.integration_run_recorded.v1"),
      eq(verrailAuditEvents.principalType, "service"), eq(verrailAuditEvents.principalId, principal), eq(verrailAuditEvents.idempotencyKey, integration.idempotencyKey))).limit(2);
    const response = { schemaVersion: 1, resourceType: "integration_run", resourceId: integration.id };
    if (commands.length !== 1 || commands[0]!.requestHash !== proof.sourcePayloadHash || !same(commands[0]!.response, { ...response, replayed: false })
      || audit.length !== 1 || !same(audit[0]!.payload, response)) unavailable();
    return { ...row, receipt, attempt, commands, audit };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const command = records.receipt.input;
  const source = await loadGitHubCiSourceContext(db, { workspaceId, targetId, targetRevisionId, graphRevisionId,
    claimId: command.claimId, workNodeId: command.workNodeId, artifactRevisionId: input.artifactRevisionId, requirementId: command.requirementId });
  if (!same(command.source, source.source) || source.source.runId !== input.runId || source.source.runAttemptId !== input.runAttemptId
    || source.source.runEventId !== native.runEventId || source.source.runEventContentHash !== native.runEventContentHash
    || source.source.outputReceiptSha256 !== native.outputReceiptSha256 || source.criterionKey !== command.criterionKey
    || source.snapshot.sourceSnapshotTreeSha !== command.mapping.sourceSnapshotTreeSha || source.snapshot.sourceContentSha256 !== command.mapping.sourceContentSha256) unavailable();
  return { binding: "linked_existing_proof" as const, artifactRevisionId: input.artifactRevisionId, artifactContentHash: records.artifact.contentHash,
    fixedCiProofId: input.fixedCiProofId, integrationRunId: records.integration.id, verificationResultId: records.verification.id,
    criterionKey: command.criterionKey, requirementId: command.requirementId, assertions: records.receipt.criterionProof.assertions,
    testedCommit: command.ci.testedCommit, sourceSnapshotTreeSha: source.snapshot.sourceSnapshotTreeSha,
    sourceContentSha256: source.snapshot.sourceContentSha256, contextSha256: digest({ input, native, records, source }) };
}
