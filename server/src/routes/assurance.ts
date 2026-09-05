import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import { verrailArtifactRevisions, type Db } from "@paperclipai/db";
import { z } from "zod";
import type { StorageService } from "../storage/types.js";
import {
  addArtifactRevisionSchema,
  createArtifactSchema,
  createClaimSchema,
  recordEvidenceSchema,
  recordVerificationResultSchema,
  targetIdempotencyKeySchema,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { createVerrailDomainApiClient, type VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";

export function assuranceRoutes(options: { domainApiClient?: VerrailDomainApiClient | null; db?: Db; storage?: StorageService } = {}) {
  const router = Router();
  const domainApi = options.domainApiClient === undefined ? createVerrailDomainApiClient() : options.domainApiClient;

  router.get("/workspaces/:workspaceId/artifact-revisions/:revisionId/content", async (req, res) => {
    assertBoardOrAgent(req);
    const workspaceId = z.string().uuid().parse(req.params.workspaceId);
    const revisionId = z.string().uuid().parse(req.params.revisionId);
    assertCompanyAccess(req, workspaceId);
    if (!options.db || !options.storage) throw new HttpError(503, "Artifact storage is unavailable");
    const [revision] = await options.db.select({ contentRef: verrailArtifactRevisions.contentRef, contentHash: verrailArtifactRevisions.contentHash })
      .from(verrailArtifactRevisions).where(and(eq(verrailArtifactRevisions.workspaceId, workspaceId), eq(verrailArtifactRevisions.id, revisionId))).limit(1);
    if (!revision || !/^[a-f0-9]{64}$/.test(revision.contentHash)
      || revision.contentRef !== `storage:${workspaceId}/verrail/run-artifacts/sha256/${revision.contentHash}`) {
      throw new HttpError(404, "Stored ArtifactRevision content not found");
    }
    const object = await options.storage.getObject(workspaceId, revision.contentRef.slice("storage:".length));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="artifact-${revisionId}.bin"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    if (object.contentLength !== undefined) res.setHeader("Content-Length", object.contentLength);
    await pipeline(object.stream, res);
  });

  function commandContext(req: Parameters<typeof getActorInfo>[0], workspaceId: string) {
    assertBoard(req);
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "A human Workspace member is required", { code: "ASSURANCE_FORBIDDEN" });
    if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "ASSURANCE_DOMAIN_API_UNAVAILABLE", retryable: true });
    return { workspaceId, principalType: "user" as const, principalId: actor.actorId, idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")) };
  }

  router.post("/workspaces/:workspaceId/artifacts", validate(createArtifactSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.createArtifact({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/artifact-revisions", validate(addArtifactRevisionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.addArtifactRevision({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/claims", validate(createClaimSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.createClaim({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/evidence", validate(recordEvidenceSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.recordEvidence({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/verification-results", validate(recordVerificationResultSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.recordVerificationResult({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
