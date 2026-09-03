import { Router } from "express";
import {
  acceptSubmissionSchema,
  createSubmissionSchema,
  recordDeliveryReviewSchema,
  targetIdempotencyKeySchema,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { createVerrailDomainApiClient, type VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function adjudicationRoutes(options: { domainApiClient?: VerrailDomainApiClient | null } = {}) {
  const router = Router();
  const domainApi = options.domainApiClient === undefined ? createVerrailDomainApiClient() : options.domainApiClient;

  function commandContext(req: Parameters<typeof getActorInfo>[0], workspaceId: string) {
    assertBoard(req);
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "A human Workspace member is required", { code: "ADJUDICATION_FORBIDDEN" });
    if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "ADJUDICATION_DOMAIN_API_UNAVAILABLE", retryable: true });
    return { workspaceId, principalType: "user" as const, principalId: actor.actorId, idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")) };
  }

  router.post("/workspaces/:workspaceId/submissions", validate(createSubmissionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.createSubmission({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/delivery-reviews", validate(recordDeliveryReviewSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.recordDeliveryReview({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/acceptances", validate(acceptSubmissionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.acceptSubmission({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
