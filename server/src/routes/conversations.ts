import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode, DirectorInstructionsView } from "@paperclipai/shared";
import { DIRECTOR_INSTRUCTIONS_CONFIG_KEY } from "@paperclipai/shared";
import { readEffectiveAgentVersion } from "../services/agent-effective-version.js";
import {
  conversationListQuerySchema,
  confirmTargetCreationDraftSchema,
  createConversationSchema,
  createProviderConversationBindingSchema,
  createTargetCreationDraftSchema,
  sendConversationMessageSchema,
  updateTargetCreationDraftSchema,
  updateConversationSchema,
  directorTargetProposalSchema,
  switchConversationContextSchema,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  builtInAgentService,
  conversationService,
  createVerrailDomainApiClient,
  logActivity,
  providerConversationBindingService,
  targetCreationDraftService,
  type VerrailDomainApiClient,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { channelTargetReplyService, reconcileChannelTargetReplySchema } from "../services/channel-target-reply.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveConversationRuntimeCommand } from "../services/conversation-runtime-command.js";
import { assertDirectorMember, createDirectorToolSessions, directorMcpRuntimeArgs, directorToolExecutor } from "../services/director-tools.js";
import { conversationContextService } from "../services/conversation-context.js";
import { buildDirectorInstructions, resolveDirectorChatRuntime } from "../services/director-instructions.js";

const MAX_CONCURRENT_CHAT_RUNS = 3;
const CHAT_TIMEOUT_MS = 120_000;
const CHAT_TERMINATION_GRACE_MS = 5_000;
const CHAT_OUTPUT_DRAIN_GRACE_MS = 1_000;
const CHAT_RUNTIME_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

type LocalChatRuntime = "codex" | "claude";

export function createConversationRunLimiter(maxConcurrentRuns: number) {
  let activeRuns = 0;
  return {
    tryAcquire() {
      if (activeRuns >= maxConcurrentRuns) return null;
      activeRuns += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeRuns -= 1;
      };
    },
    activeCount() {
      return activeRuns;
    },
  };
}

export function scheduleConversationRuntimeTermination(
  proc: {
    exitCode: number | null;
    pid?: number;
    kill: (signal: NodeJS.Signals) => boolean;
  },
  onEscalated: () => void,
  graceMs = CHAT_TERMINATION_GRACE_MS,
) {
  if (proc.exitCode !== null) return null;
  signalConversationRuntimeTree(proc, "SIGTERM");
  return setTimeout(() => {
    signalConversationRuntimeTree(proc, "SIGKILL");
    onEscalated();
  }, graceMs);
}

export function signalConversationRuntimeTree(
  proc: { pid?: number; kill: (signal: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {
      // Fall back to the direct child when the process group is already gone.
    }
  }
  try {
    return proc.kill(signal);
  } catch {
    return false;
  }
}

export function createConversationRuntimeCleanupBarrier(options: {
  release: () => void;
  removeRuntimeDirectory: () => void;
  forceStopTree: () => void;
  destroyOutputStreams: () => void;
  drainGraceMs?: number;
}) {
  let cleanedUp = false;
  let outputDrainTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (outputDrainTimer) clearTimeout(outputDrainTimer);
    options.release();
    options.removeRuntimeDirectory();
  };
  return {
    onExit() {
      if (outputDrainTimer || cleanedUp) return;
      outputDrainTimer = setTimeout(() => {
        options.forceStopTree();
        options.destroyOutputStreams();
      }, options.drainGraceMs ?? CHAT_OUTPUT_DRAIN_GRACE_MS);
    },
    onClose: cleanup,
    onError: cleanup,
  };
}

function resolveLocalChatRuntime(): LocalChatRuntime {
  return resolveDirectorChatRuntime();
}

export function buildConversationRuntimeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
  for (const key of CHAT_RUNTIME_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  const chatProxy = source.VERRAIL_CHAT_HTTPS_PROXY?.trim();
  if (chatProxy) {
    env.HTTPS_PROXY = chatProxy;
    env.HTTP_PROXY = chatProxy;
    env.ALL_PROXY = chatProxy;
    env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  return env;
}

function serializeTurn(role: "user" | "assistant", body: string) {
  const safeBody = body.replace(/<(\/?turn\b)/gi, "&lt;$1");
  return `<turn role="${role}">\n${safeBody}\n</turn>`;
}

function actorIdentity(actor: ReturnType<typeof getActorInfo>) {
  return {
    principalType: actor.actorType,
    principalId: actor.actorId,
  } as const;
}

export function classifyConversationRuntimeOutcome(
  responseText: string,
  exitCode: number | null,
  timedOut: boolean,
) {
  const text = responseText.trim();
  if (!text) {
    return {
      kind: "error" as const,
      message: timedOut
        ? "The conversational runtime timed out."
        : exitCode !== 0
          ? "The local conversational runtime could not complete the response."
          : "The local conversational runtime did not return a response.",
    };
  }
  return {
    kind: "response" as const,
    text,
    status: exitCode === 0 && !timedOut ? "complete" as const : "failed" as const,
  };
}

export function conversationRoutes(db: Db, opts: {
  deploymentMode: DeploymentMode;
  domainApiClient?: VerrailDomainApiClient | null;
  pluginWorkerManager?: Pick<PluginWorkerManager, "call">;
  publicBaseUrl?: string | null;
  targetReplies?: Pick<ReturnType<typeof channelTargetReplyService>, "deliver" | "read"> & Partial<Pick<ReturnType<typeof channelTargetReplyService>, "reconcile">>;
}) {
  const router = Router();
  const conversations = conversationService(db);
  const drafts = targetCreationDraftService(db);
  const targetReplies = opts.targetReplies ?? channelTargetReplyService(db, { workerManager: opts.pluginWorkerManager, publicBaseUrl: opts.publicBaseUrl });
  const providerBindings = providerConversationBindingService(db);
  const domainApi = opts.domainApiClient === undefined
    ? createVerrailDomainApiClient()
    : opts.domainApiClient;
  const builtInAgents = builtInAgentService(db);
  const runLimiter = createConversationRunLimiter(MAX_CONCURRENT_CHAT_RUNS);
  const directorSessions = createDirectorToolSessions();

  router.post("/director/mcp", async (req, res) => {
    if (opts.deploymentMode !== "local_trusted") throw notFound("Not found");
    const result = await directorSessions.handle(req.get("X-Verrail-Chat-Token") ?? "", req.body);
    if (result === null) res.sendStatus(202);
    else res.json(result);
  });

  router.post("/workspaces/:workspaceId/conversations/:conversationId/proposals/:messageId/confirm", async (req, res) => {
    assertBoard(req);
    z.object({}).strict().parse(req.body);
    const workspaceId = req.params.workspaceId as string;
    const conversationId = req.params.conversationId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    await assertDirectorMember(db, workspaceId, actor.actorId, true);
    const conversation = await conversations.get(workspaceId, conversationId);
    if (!conversation || conversation.status !== "active") throw notFound("Active conversation not found");
    const message = conversation.messages.find((entry) => entry.id === req.params.messageId && entry.role === "tool");
    const parsed = directorTargetProposalSchema.safeParse(message?.metadata);
    if (!message || !parsed.success || parsed.data.initiatedByPrincipalId !== actor.actorId) throw notFound("Proposal not found");
    if (!domainApi) throw new HttpError(503, "Domain API unavailable");
    const result = await domainApi.manageTarget({ workspaceId, targetId: parsed.data.targetId, principalType: "user", principalId: actor.actorId, idempotencyKey: `director-${message.id}`, input: parsed.data.input });
    if (!result.replayed) await logActivity(db, { companyId: workspaceId, actorType: actor.actorType, actorId: actor.actorId, action: "target.managed", entityType: "target", entityId: result.targetId, details: { operation: result.operation, targetRevisionId: result.targetRevisionId, proposalMessageId: message.id, conversationId } });
    await conversations.appendMessage(workspaceId, conversationId, { role: "tool", body: parsed.data.targetTitle, metadata: { kind: "director_target_result", proposalMessageId: message.id, result }, actor: actorIdentity(actor) });
    res.json(result);
  });

  router.get("/workspaces/:workspaceId/conversations", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const query = conversationListQuerySchema.parse(req.query);
    res.json(await conversations.list(workspaceId, query));
  });

  router.post("/workspaces/:workspaceId/conversations", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    const created = await conversations.create(
      workspaceId,
      createConversationSchema.parse(req.body),
      actorIdentity(actor),
    );
    await logActivity(db, {
      companyId: workspaceId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "conversation.created",
      entityType: "conversation",
      entityId: created.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: { contextCount: created.contextBindings.length },
    });
    res.status(201).json(created);
  });

  router.get("/workspaces/:workspaceId/conversations/:conversationId", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const conversation = await conversations.get(workspaceId, req.params.conversationId as string);
    if (!conversation) throw notFound("Conversation not found");
    res.json(conversation);
  });

  router.patch("/workspaces/:workspaceId/conversations/:conversationId", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const input = updateConversationSchema.parse(req.body);
    const conversation = await conversations.update(
      workspaceId,
      req.params.conversationId as string,
      input,
    );
    if (!conversation) throw notFound("Conversation not found");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: workspaceId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "conversation.updated",
      entityType: "conversation",
      entityId: conversation.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: input,
    });
    res.json(conversation);
  });

  router.post("/workspaces/:workspaceId/conversations/:conversationId/context", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "A human Workspace member is required");
    const result = await conversationContextService(db).switch({ workspaceId, conversationId: req.params.conversationId as string, principalId: actor.actorId }, switchConversationContextSchema.parse(req.body));
    res.json(result);
  });

  router.post("/workspaces/:workspaceId/conversations/:conversationId/messages", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    const conversationId = req.params.conversationId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    const input = sendConversationMessageSchema.parse(req.body);
    const message = await conversations.appendMessage(workspaceId, conversationId, {
      role: "user",
      body: input.body,
      actor: actorIdentity(actor),
      metadata: { intent: "structured_user_message" },
    });
    if (!message) throw notFound("Conversation not found");
    res.status(201).json(message);
  });

  router.post("/workspaces/:workspaceId/provider-conversation-bindings", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    const binding = await providerBindings.create(
      workspaceId,
      createProviderConversationBindingSchema.parse(req.body),
      actorIdentity(actor),
    );
    res.status(201).json(binding);
  });

  router.get("/workspaces/:workspaceId/provider-conversation-bindings/resolve", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const connectionId = String(req.query.connectionId ?? "").trim();
    const externalConversationId = String(req.query.externalConversationId ?? "").trim();
    if (!connectionId || !externalConversationId) {
      throw new HttpError(400, "connectionId and externalConversationId are required");
    }
    const binding = await providerBindings.resolve(workspaceId, connectionId, externalConversationId);
    if (!binding) throw notFound("Provider conversation binding not found");
    res.json(binding);
  });

  router.get("/workspaces/:workspaceId/conversations/:conversationId/target-drafts", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    res.json(await drafts.list(workspaceId, req.params.conversationId as string));
  });

  router.post("/workspaces/:workspaceId/conversations/:conversationId/target-drafts", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    const conversationId = req.params.conversationId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      throw new HttpError(403, "A human Workspace member is required", { code: "TARGET_DRAFT_FORBIDDEN" });
    }
    const draft = await drafts.create(
      workspaceId,
      conversationId,
      createTargetCreationDraftSchema.parse(req.body),
      actorIdentity(actor),
    );
    res.status(201).json(draft);
  });

  router.patch("/workspaces/:workspaceId/conversations/:conversationId/target-drafts/:draftId", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    const conversationId = req.params.conversationId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    const draft = await drafts.update(
      workspaceId,
      conversationId,
      req.params.draftId as string,
      updateTargetCreationDraftSchema.parse(req.body),
      actorIdentity(actor),
    );
    res.json(draft);
  });

  router.post("/workspaces/:workspaceId/conversations/:conversationId/target-drafts/:draftId/cancel", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    res.json(await drafts.cancel(
      workspaceId,
      req.params.conversationId as string,
      req.params.draftId as string,
    ));
  });

  router.get("/workspaces/:workspaceId/conversations/:conversationId/target-drafts/:draftId/channel-reply", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    res.set("Cache-Control", "no-store").json(await targetReplies.read({ workspaceId,
      conversationId: req.params.conversationId as string, draftId: req.params.draftId as string, principalId: getActorInfo(req).actorId }));
  });

  router.post("/workspaces/:workspaceId/conversations/:conversationId/target-drafts/:draftId/channel-reply/reconcile", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "A human Workspace member is required");
    const parsed = reconcileChannelTargetReplySchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid reply reference");
    if (!targetReplies.reconcile) throw new HttpError(503, "Reply reconciliation unavailable");
    const result = await targetReplies.reconcile({ ...parsed.data, workspaceId, conversationId: req.params.conversationId as string,
      draftId: req.params.draftId as string, principalId: actor.actorId });
    res.set("Cache-Control", "no-store").status(result.status === "blocked" ? 409 : 200).json(result);
  });

  router.post("/workspaces/:workspaceId/conversations/:conversationId/target-drafts/:draftId/confirm", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    const conversationId = req.params.conversationId as string;
    const draftId = req.params.draftId as string;
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      throw new HttpError(403, "A human Workspace member is required", { code: "TARGET_CREATE_FORBIDDEN" });
    }
    if (!domainApi) {
      throw new HttpError(503, "Verrail Domain API is unavailable", {
        code: "TARGET_DOMAIN_API_UNAVAILABLE",
        retryable: true,
      });
    }
    const input = confirmTargetCreationDraftSchema.parse(req.body);
    const prepared = await drafts.prepareConfirmation(
      workspaceId,
      conversationId,
      draftId,
      input.expectedRevisionNumber,
      actorIdentity(actor),
    );
    const definition = prepared.draft.activeRevision.definition;
    const target = await domainApi.createTarget({
      workspaceId,
      principalType: "user",
      principalId: actor.actorId,
      idempotencyKey: prepared.draft.conversionIdempotencyKey!,
      input: {
        collectionId: definition.collectionId,
        title: definition.title!,
        summary: definition.summary,
        outcomeOwner: definition.outcomeOwner!,
        goal: definition.goal!,
        constraints: definition.constraints,
        acceptanceCriteria: definition.acceptanceCriteria,
        riskLevel: definition.riskLevel!,
        deadline: definition.deadline,
        policySummary: definition.policySummary,
        resourceRefs: definition.resourceRefs.map((ref) => ({
          kind: ref.kind,
          id: ref.id,
          label: ref.label ?? null,
        })),
      },
    });
    await drafts.finalizeConfirmation({
      workspaceId,
      conversationId,
      draftId,
      targetId: target.targetId,
      targetRevisionId: target.targetRevisionId,
      title: definition.title!,
    });
    const channelReply = await targetReplies.deliver({ workspaceId, conversationId, draftId, principalId: actor.actorId });
    res.status(target.replayed ? 200 : 201).json({
      draft: await drafts.get(workspaceId, conversationId, draftId),
      target,
      channelReply,
    });
  });

  router.post(
    "/workspaces/:workspaceId/conversations/:conversationId/messages/stream",
    async (req, res) => {
      assertBoard(req);
      const workspaceId = req.params.workspaceId as string;
      const conversationId = req.params.conversationId as string;
      assertCompanyAccess(req, workspaceId);
      if (opts.deploymentMode !== "local_trusted") {
        res.status(503).json({
          error: "Conversational execution is not configured for this deployment",
          code: "CONVERSATION_RUNTIME_UNAVAILABLE",
        });
        return;
      }
      const input = sendConversationMessageSchema.parse(req.body);
      const releaseRun = runLimiter.tryAcquire();
      if (!releaseRun) {
        res.status(429).json({ error: "Too many active conversations", code: "CONVERSATION_BUSY" });
        return;
      }

      let runtimeCwd: string | null = null;
      let directorSession: { token: string; revoke: () => void } | null = null;
      let requestClosed = false;
      let terminateRuntime: (() => void) | null = null;
      res.on("close", () => {
        requestClosed = true;
        directorSession?.revoke();
        terminateRuntime?.();
      });

      let userMessage;
      let conversation;
      let assistantAgent: { id: string; name: string } | null = null;
      let instructionSnapshot: DirectorInstructionsView;
      let effective: Awaited<ReturnType<typeof readEffectiveAgentVersion>>;
      try {
        const actor = getActorInfo(req);
        userMessage = await conversations.appendMessage(workspaceId, conversationId, {
          role: "user",
          body: input.body,
          actor: actorIdentity(actor),
        });
        if (!userMessage) throw notFound("Conversation not found");
        conversation = await conversations.get(workspaceId, conversationId);
        if (!conversation) throw notFound("Conversation not found");
        const directorState = await builtInAgents.get(workspaceId, "director");
        if (
          directorState.agent
          && directorState.agent.status !== "pending_approval"
          && directorState.agent.status !== "terminated"
          && directorState.agent.status !== "paused"
          && !directorState.agent.pausedAt
        ) {
          assistantAgent = {
            id: directorState.agent.id,
            name: directorState.agent.name,
          };
          effective = await readEffectiveAgentVersion(db, workspaceId, directorState.agent.id);
          if (effective.version.supplyChain.mode !== "director_chat" || !["codex", "claude"].includes(effective.version.runtime)) throw new HttpError(409, "Activate a Director chat version before chatting");
          instructionSnapshot = buildDirectorInstructions({
            agentName: directorState.agent.name, adapterConfig: { [DIRECTOR_INSTRUCTIONS_CONFIG_KEY]: {
              schemaVersion: 1, revision: effective.version.versionNumber, rolePrompt: effective.version.prompt,
              appliedAt: effective.revision.createdAt.toISOString(), appliedByUserId: effective.revision.createdByPrincipalId,
            } },
            runtime: effective.version.runtime as LocalChatRuntime, available: true,
            toolsAvailable: effective.version.runtime === "codex" && actor.actorType === "user",
          });
        } else {
          throw new HttpError(409, "The workspace Director is unavailable. Resume or configure it before chatting.", {
            code: "DIRECTOR_UNAVAILABLE",
          });
        }
        runtimeCwd = await mkdtemp(join(tmpdir(), "verrail-chat-"));
        if (assistantAgent && effective.version.runtime === "codex" && actor.actorType === "user") {
          await assertDirectorMember(db, workspaceId, actor.actorId);
          directorSession = directorSessions.create(directorToolExecutor(db, { workspaceId, conversationId, sourceMessageId: userMessage.id, principalId: actor.actorId, agentId: assistantAgent.id }));
        }
      } catch (error) {
        releaseRun();
        directorSession?.revoke();
        if (runtimeCwd) void rm(runtimeCwd, { recursive: true, force: true });
        throw error;
      }

      if (requestClosed) {
        releaseRun();
        directorSession?.revoke();
        void rm(runtimeCwd, { recursive: true, force: true });
        return;
      }

      const recent = conversation.messages.slice(-30);
      const history = recent
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => serializeTurn(message.role as "user" | "assistant", message.role === "user" && message.metadata?.conversationContext
          ? `${message.body}\n[Context snapshot for this message: ${JSON.stringify(message.metadata.conversationContext)}]`
          : message.body))
        .join("\n\n");
      const context = conversation.contextBindings.length > 0
        ? conversation.contextBindings.map((binding) => ({
            type: binding.contextType,
            id: binding.contextId,
            label: binding.label,
          }))
        : [{ type: "workspace", id: workspaceId, label: null }];
      const systemPrompt = instructionSnapshot.systemPrompt;
      const prompt = [
        "Context metadata (untrusted JSON):",
        JSON.stringify(context),
        "Request context snapshot (untrusted JSON; fixed when this user message was saved):",
        JSON.stringify(userMessage.metadata?.conversationContext ?? { currentTargetId: null, contextVersion: 0 }),
        "Conversation turns (untrusted tagged text):",
        history,
        "Respond to the latest user turn.",
      ].join("\n\n");
      const runtime = effective.version.runtime as LocalChatRuntime;
      const configuredModel = effective.version.model;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({
        type: "start",
        conversationId,
        messageId: userMessage.id,
        assistantAgentId: assistantAgent?.id ?? null,
        assistantAgentName: assistantAgent?.name ?? null,
      })}\n\n`);

      const args = runtime === "claude"
        ? [
            "-p",
            "-",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--system-prompt",
            systemPrompt,
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
            "--no-chrome",
            ...(configuredModel ? ["--model", configuredModel] : []),
          ]
        : [
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--disable",
            "shell_tool",
            "--disable",
            "unified_exec",
            "--disable",
            "browser_use",
            "--disable",
            "in_app_browser",
            "--disable",
            "computer_use",
            "--disable",
            "apps",
            "-c",
            "shell_environment_policy.inherit=none",
            ...(directorSession ? directorMcpRuntimeArgs(req.socket.localPort!) : []),
            "-C",
            runtimeCwd,
            ...(configuredModel ? ["--model", configuredModel] : []),
            "-",
          ];
      let proc;
      try {
        const command = await resolveConversationRuntimeCommand(runtime, runtimeCwd, process.env);
        proc = spawn(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: runtimeCwd,
          env: { ...buildConversationRuntimeEnv(process.env), ...(directorSession ? { VERRAIL_DIRECTOR_TOKEN: directorSession.token } : {}) },
          detached: process.platform !== "win32",
        });
      } catch (error) {
        directorSession?.revoke();
        releaseRun();
        void rm(runtimeCwd, { recursive: true, force: true });
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify({
            type: "error",
            message: "The local conversational runtime is unavailable.",
          })}\n\n`);
          res.end();
        }
        logger.error({ err: error, workspaceId, conversationId }, "Conversation runtime failed to start");
        return;
      }

      let responseText = "";
      let streamedViaDelta = false;
      let timedOut = false;
      let stderrBytes = 0;
      let finalized = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let runtimeClosed = false;
      const cleanupBarrier = createConversationRuntimeCleanupBarrier({
        release: () => { directorSession?.revoke(); releaseRun(); },
        removeRuntimeDirectory: () => {
          void rm(runtimeCwd, { recursive: true, force: true });
        },
        forceStopTree: () => {
          signalConversationRuntimeTree(proc, "SIGKILL");
        },
        destroyOutputStreams: () => {
          proc.stdout.destroy();
          proc.stderr.destroy();
        },
      });
      const handleTerminationEscalation = () => {
        clearTimeout(timeout);
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify({
            type: "error",
            message: timedOut
              ? "The conversational runtime timed out."
              : "The local conversational runtime could not be stopped.",
          })}\n\n`);
          res.end();
        }
      };
      terminateRuntime = () => {
        if (forceKillTimer || runtimeClosed) return;
        forceKillTimer = scheduleConversationRuntimeTermination(proc, handleTerminationEscalation);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateRuntime?.();
      }, CHAT_TIMEOUT_MS);
      if (requestClosed) terminateRuntime();

      proc.stderr.on("data", (data: Buffer) => {
        stderrBytes += data.length;
      });

      let stdoutBuffer = "";
      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          const inner = event.type === "stream_event" ? event.event : event;
          if (runtime === "codex" && event.type === "item.completed"
            && event.item?.type === "agent_message" && event.item.text) {
            responseText += event.item.text;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "chunk", text: event.item.text })}\n\n`);
            }
          } else if (runtime === "claude" && inner?.type === "content_block_delta" && inner.delta?.text) {
            streamedViaDelta = true;
            responseText += inner.delta.text;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "chunk", text: inner.delta.text })}\n\n`);
            }
          } else if (runtime === "claude" && event.type === "assistant" && event.message?.content && !streamedViaDelta) {
            for (const block of event.message.content) {
              if (block.type !== "text" || !block.text) continue;
              responseText += block.text;
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type: "chunk", text: block.text })}\n\n`);
              }
            }
          } else if (runtime === "claude" && event.type === "result" && event.result && !responseText) {
            responseText = event.result;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "chunk", text: event.result })}\n\n`);
            }
          }
        }
      });

      const finalizeRuntime = async (exitCode: number | null) => {
        if (finalized) return;
        finalized = true;
        try {
          const outcome = classifyConversationRuntimeOutcome(responseText, exitCode, timedOut);
          if (outcome.kind === "error") {
            logger.warn(
              { runtime, exitCode, timedOut, stderrBytes, workspaceId, conversationId },
              "Conversation runtime exited without a response",
            );
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({
                type: "error",
                message: outcome.message,
              })}\n\n`);
              res.end();
            }
            return;
          }
          let assistantMessageId: string | null = null;
          const assistantMessage = await conversations.appendMessage(workspaceId, conversationId, {
            role: "assistant",
            body: outcome.text,
            status: outcome.status,
            actor: assistantAgent
              ? { principalType: "agent", principalId: assistantAgent.id }
              : undefined,
            metadata: {
              runtime,
              agentVersionId: effective.version.id,
              deploymentRevisionId: effective.revision.id,
              agentVersionHash: effective.version.contentHash,
              exitCode: exitCode ?? 0,
              timedOut,
              defaultAgentKey: assistantAgent ? "director" : null,
              assistantAgentName: assistantAgent?.name ?? null,
              instructions: {
                mode: instructionSnapshot.mode,
                revision: instructionSnapshot.revision,
                configHash: instructionSnapshot.configHash,
                roleSource: instructionSnapshot.roleSource,
                roleHash: instructionSnapshot.roleHash,
                policyVersion: instructionSnapshot.policyVersion,
                effectiveHash: instructionSnapshot.effectiveHash,
              },
              sourceMessageId: userMessage.id,
              conversationContext: userMessage.metadata?.conversationContext ?? null,
            },
          });
          assistantMessageId = assistantMessage?.id ?? null;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
              type: "done",
              conversationId,
              assistantMessageId,
              exitCode: exitCode ?? 0,
              timedOut,
            })}\n\n`);
            res.end();
          }
        } catch (error) {
          logger.error({ err: error, workspaceId, conversationId }, "Failed to persist conversation response");
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
              type: "error",
              message: "The response could not be saved.",
            })}\n\n`);
            res.end();
          }
        }
      };

      proc.on("exit", () => {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        cleanupBarrier.onExit();
      });

      proc.on("close", (exitCode) => {
        runtimeClosed = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        cleanupBarrier.onClose();
        void finalizeRuntime(exitCode);
      });

      proc.on("error", (error) => {
        if (finalized) return;
        finalized = true;
        runtimeClosed = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        cleanupBarrier.onError();
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify({
            type: "error",
            message: "The local conversational runtime is unavailable.",
          })}\n\n`);
          res.end();
        }
        logger.error({ err: error, workspaceId, conversationId }, "Conversation runtime failed to start");
      });

      proc.stdin.write(runtime === "codex" ? `${systemPrompt}\n\n${prompt}` : prompt);
      proc.stdin.end();
    },
  );

  return router;
}
