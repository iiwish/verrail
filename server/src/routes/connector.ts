import { Router } from "express";
import {
  approveActionSchema,
  createGithubRepoBindingSchema,
  executeActionSchema,
  recordIntegrationRunSchema,
  requestPullRequestActionSchema,
  targetIdempotencyKeySchema,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { createVerrailDomainApiClient, type VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function connectorRoutes(options: { domainApiClient?: VerrailDomainApiClient | null } = {}) {
  const router = Router();
  const domainApi = options.domainApiClient === undefined ? createVerrailDomainApiClient() : options.domainApiClient;

  function commandContext(req: Parameters<typeof getActorInfo>[0], workspaceId: string) {
    assertBoard(req);
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "A human Workspace member is required", { code: "CONNECTOR_FORBIDDEN" });
    if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "CONNECTOR_DOMAIN_API_UNAVAILABLE", retryable: true });
    return { workspaceId, principalType: "user" as const, principalId: actor.actorId, idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")) };
  }

  router.post("/workspaces/:workspaceId/integration-runs", validate(recordIntegrationRunSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.recordIntegrationRun({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/pull-request-actions", validate(requestPullRequestActionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.requestPullRequestAction({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/pull-request-actions/:actionRequestId/approvals", validate(approveActionSchema), async (req, res) => {
    const actionRequestId = req.params.actionRequestId as string;
    if (req.body.actionRequestId !== actionRequestId) {
      throw new HttpError(400, "The action request in the path must match the request in the payload", { code: "CONNECTOR_PATH_PAYLOAD_MISMATCH" });
    }
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.approveAction({ ...context, actionRequestId, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/pull-request-actions/:actionRequestId/executions", validate(executeActionSchema), async (req, res) => {
    const actionRequestId = req.params.actionRequestId as string;
    if (req.body.actionRequestId !== actionRequestId) {
      throw new HttpError(400, "The action request in the path must match the request in the payload", { code: "CONNECTOR_PATH_PAYLOAD_MISMATCH" });
    }
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.executeAction({ ...context, actionRequestId, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/github-repo-bindings", validate(createGithubRepoBindingSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.createGithubRepoBinding({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
