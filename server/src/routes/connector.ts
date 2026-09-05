import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  approveActionSchema,
  createGithubRepoBindingSchema,
  executeActionSchema,
  recordHumanWorkResultSchema,
  recordIntegrationRunSchema,
  requestPullRequestActionSchema,
  targetIdempotencyKeySchema,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { createVerrailDomainApiClient, type VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import {
  resolveGithubConnectorCredential,
  type GithubConnectorCredential,
  type GithubConnectorCredentialActor,
} from "../services/secrets.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";

export function connectorRoutes(options: {
  db?: Db;
  domainApiClient?: VerrailDomainApiClient | null;
  resolveGithubCredential?: (
    workspaceId: string,
    actor: GithubConnectorCredentialActor,
  ) => Promise<GithubConnectorCredential>;
} = {}) {
  const router = Router();
  const domainApi = options.domainApiClient === undefined ? createVerrailDomainApiClient() : options.domainApiClient;
  const resolveGithubCredential = options.resolveGithubCredential
    ?? (options.db ? (workspaceId: string, actor: GithubConnectorCredentialActor) =>
      resolveGithubConnectorCredential(options.db!, workspaceId, actor) : null);

  function humanCommandContext(req: Parameters<typeof getActorInfo>[0], workspaceId: string) {
    assertBoard(req);
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "A human Workspace member is required", { code: "CONNECTOR_FORBIDDEN" });
    if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "CONNECTOR_DOMAIN_API_UNAVAILABLE", retryable: true });
    return { workspaceId, principalType: "user" as const, principalId: actor.actorId, idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")) };
  }

  function candidateCommandContext(req: Parameters<typeof getActorInfo>[0], workspaceId: string) {
    assertBoardOrAgent(req);
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "CONNECTOR_DOMAIN_API_UNAVAILABLE", retryable: true });
    return { workspaceId, principalType: actor.actorType, principalId: actor.actorId, idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")) };
  }

  router.post("/workspaces/:workspaceId/integration-runs", validate(recordIntegrationRunSchema), async (req, res) => {
    const context = humanCommandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.recordIntegrationRun({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/human-work-results", validate(recordHumanWorkResultSchema), async (req, res) => {
    const context = humanCommandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.recordHumanWorkResult({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/pull-request-actions", validate(requestPullRequestActionSchema), async (req, res) => {
    const context = candidateCommandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.requestPullRequestAction({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/pull-request-actions/:actionRequestId/approvals", validate(approveActionSchema), async (req, res) => {
    const actionRequestId = req.params.actionRequestId as string;
    if (req.body.actionRequestId !== actionRequestId) {
      throw new HttpError(400, "The action request in the path must match the request in the payload", { code: "CONNECTOR_PATH_PAYLOAD_MISMATCH" });
    }
    const context = humanCommandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.approveAction({ ...context, actionRequestId, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/pull-request-actions/:actionRequestId/executions", validate(executeActionSchema), async (req, res) => {
    const actionRequestId = req.params.actionRequestId as string;
    if (req.body.actionRequestId !== actionRequestId) {
      throw new HttpError(400, "The action request in the path must match the request in the payload", { code: "CONNECTOR_PATH_PAYLOAD_MISMATCH" });
    }
    const context = humanCommandContext(req, req.params.workspaceId as string);
    if (!resolveGithubCredential) {
      throw new HttpError(503, "GitHub credential resolution is unavailable", {
        code: "CONNECTOR_CREDENTIAL_RESOLVER_UNAVAILABLE",
        retryable: false,
      });
    }
    const actor = getActorInfo(req);
    const credential = await resolveGithubCredential(context.workspaceId, {
      actorType: "user",
      actorId: actor.actorId,
    });
    const result = await domainApi!.executeAction({
      ...context,
      actionRequestId,
      githubConnectionId: credential.connectionId,
      githubAuthorization: credential.authorization,
      input: req.body,
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/github-repo-bindings", validate(createGithubRepoBindingSchema), async (req, res) => {
    const context = humanCommandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.createGithubRepoBinding({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
