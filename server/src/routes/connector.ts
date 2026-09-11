import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  approveActionSchema,
  collectGithubCiObservationSchema,
  createGithubRepoBindingSchema,
  executeActionSchema,
  recordHumanWorkResultSchema,
  recordIntegrationRunSchema,
  recordGithubFixedCiProofSchema,
  requestPullRequestActionSchema,
  targetIdempotencyKeySchema,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { createGitHubCiObservationCollector } from "../services/github-ci-proof-collector.js";
import { createGitHubFixedCiProofRecorder } from "../services/github-fixed-ci-proof-recorder.js";
import { validate } from "../middleware/validate.js";
import { createVerrailDomainApiClient, type VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import {
  resolveGithubConnectorCredential,
  type GithubConnectorCredential,
  type GithubConnectorCredentialActor,
} from "../services/secrets.js";
import { assertAuthenticated, assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";

export function connectorRoutes(options: {
  db?: Db;
  domainApiClient?: VerrailDomainApiClient | null;
  collectGithubCiObservation?: ReturnType<typeof createGitHubCiObservationCollector>["collect"];
  recordGithubFixedCiProof?: NonNullable<ReturnType<typeof createGitHubFixedCiProofRecorder>>["record"] | null;
  resolveGithubCredential?: (
    workspaceId: string,
    actor: GithubConnectorCredentialActor,
  ) => Promise<GithubConnectorCredential>;
} = {}) {
  const router = Router();
  const domainApi = options.domainApiClient === undefined ? createVerrailDomainApiClient() : options.domainApiClient;
  const collectGithubCiObservation = options.collectGithubCiObservation
    ?? (options.db ? createGitHubCiObservationCollector({ db: options.db }).collect : null);
  const recordGithubFixedCiProof = options.recordGithubFixedCiProof === undefined
    ? (options.db ? createGitHubFixedCiProofRecorder({ db: options.db })?.record : null)
    : options.recordGithubFixedCiProof;
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

  function collectionActor(req: Parameters<typeof getActorInfo>[0], workspaceId: string): GithubConnectorCredentialActor {
    assertAuthenticated(req);
    assertBoard(req);
    assertCompanyAccess(req, workspaceId);
    const { userId, source } = req.actor;
    if (!userId?.trim() || !["session", "board_key", "cloud_tenant", "local_implicit"].includes(source ?? "")) {
      throw new HttpError(403, "An authenticated Workspace user is required", { code: "GITHUB_CI_COLLECTION_FORBIDDEN" });
    }
    if (source !== "local_implicit") {
      const membership = req.actor.memberships?.find((item) => item.companyId === workspaceId);
      if (!membership || membership.status !== "active" || membership.membershipRole === "viewer") {
        throw new HttpError(403, "Active non-viewer Workspace membership is required", { code: "GITHUB_CI_COLLECTION_FORBIDDEN" });
      }
    }
    return { actorType: "user", actorId: userId, actorSource: source as "session" | "board_key" | "cloud_tenant" | "local_implicit" };
  }

  router.post("/workspaces/:workspaceId/targets/:targetId/github-ci-observations", validate(collectGithubCiObservationSchema), async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const actor = collectionActor(req, workspaceId);
    if (!collectGithubCiObservation) {
      throw new HttpError(503, "GitHub CI collection is unavailable", { code: "GITHUB_CI_COLLECTION_UNAVAILABLE", retryable: false });
    }
    const result = await collectGithubCiObservation({
      workspaceId,
      targetId: req.params.targetId as string,
      actor,
      input: req.body,
    });
    res.status(201).json(result);
  });

  router.post("/workspaces/:workspaceId/targets/:targetId/github-fixed-ci-proofs", validate(recordGithubFixedCiProofSchema), async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const actor = collectionActor(req, workspaceId);
    const idempotencyKey = targetIdempotencyKeySchema.parse(req.header("Idempotency-Key"));
    if (!recordGithubFixedCiProof) throw new HttpError(503, "GitHub fixed CI proof recording is disabled", { retryable: false });
    const result = await recordGithubFixedCiProof({ workspaceId, targetId: req.params.targetId as string,
      actor, idempotencyKey, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });

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
