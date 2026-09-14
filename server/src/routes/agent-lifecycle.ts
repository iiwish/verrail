import { Router } from "express";
import { type Db, verrailAgentDefinitions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  createAgentDefinitionSchema,
  createDeploymentSchema,
  publishAgentVersionSchema,
  publishSavedAgentVersionSchema,
  recordEvaluationRunSchema,
  reviseDeploymentSchema,
  targetIdempotencyKeySchema,
  updateAgentDefinitionSchema,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentLifecycleService } from "../services/agent-lifecycle.js";
import { readAgentPublication } from "../services/agent-publication.js";
import { createVerrailDomainApiClient, type VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentLifecycleRoutes(db: Db, options: { domainApiClient?: VerrailDomainApiClient | null } = {}) {
  const router = Router();
  const service = agentLifecycleService(db);
  const domainApi = options.domainApiClient === undefined ? createVerrailDomainApiClient() : options.domainApiClient;

  function commandContext(req: Parameters<typeof getActorInfo>[0], workspaceId: string) {
    assertBoard(req);
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "A human Workspace member is required", { code: "AGENT_LIFECYCLE_FORBIDDEN" });
    if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "AGENT_DOMAIN_API_UNAVAILABLE", retryable: true });
    return { workspaceId, principalType: "user" as const, principalId: actor.actorId, idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")) };
  }

  router.get("/workspaces/:workspaceId/agent-lifecycle", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    res.json(await service.getWorkspace(workspaceId));
  });
  router.post("/workspaces/:workspaceId/agent-definitions", validate(createAgentDefinitionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.createAgentDefinition({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.get("/workspaces/:workspaceId/agents/:agentId/publication-preview", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.workspaceId as string);
    res.json(await readAgentPublication(db, req.params.workspaceId as string, req.params.agentId as string));
  });
  router.post("/workspaces/:workspaceId/agent-definitions/:definitionId/publish-saved", validate(publishSavedAgentVersionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const [definition] = await db.select().from(verrailAgentDefinitions).where(and(eq(verrailAgentDefinitions.id, req.params.definitionId as string), eq(verrailAgentDefinitions.workspaceId, context.workspaceId)));
    if (!definition?.compatibilityAgentId) throw new HttpError(404, "Linked AgentDefinition not found");
    const preview = await readAgentPublication(db, context.workspaceId, definition.compatibilityAgentId);
    if (preview.sourceHash !== req.body.sourceHash) throw new HttpError(409, "Saved configuration changed. Refresh the publication preview before publishing.");
    const result = await domainApi!.publishAgentVersion({ ...context, definitionId: definition.id, input: preview.snapshot });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.patch("/workspaces/:workspaceId/agent-definitions/:definitionId", validate(updateAgentDefinitionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.updateAgentDefinition({ ...context, definitionId: req.params.definitionId as string, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/agent-definitions/:definitionId/versions", validate(publishAgentVersionSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.publishAgentVersion({ ...context, definitionId: req.params.definitionId as string, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/evaluation-runs", validate(recordEvaluationRunSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.recordEvaluationRun({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/deployments", validate(createDeploymentSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.createDeployment({ ...context, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post("/workspaces/:workspaceId/deployments/:deploymentId/revisions", validate(reviseDeploymentSchema), async (req, res) => {
    const context = commandContext(req, req.params.workspaceId as string);
    const result = await domainApi!.reviseDeployment({ ...context, deploymentId: req.params.deploymentId as string, input: req.body });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
