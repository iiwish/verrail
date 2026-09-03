import type {
  ActivateGraphRevisionResponseV1,
  CreateGraphRevisionInputV1,
  CreateGraphRevisionResponseV1,
  CreateRunInputV1,
  CreateRunResponseV1,
  CreateTargetInputV1,
  CreateTargetResponseV1,
  AgentLifecycleCommandResponseV1,
  CreateAgentDefinitionInputV1,
  UpdateAgentDefinitionInputV1,
  PublishAgentVersionInputV1,
  RecordEvaluationRunInputV1,
  CreateDeploymentInputV1,
  ReviseDeploymentInputV1,
  CreateRunAttemptInputV1,
  CreateRunAttemptResponseV1,
  ReportRunEventInputV1,
  ReportRunEventResponseV1,
  RequestRunCancellationResponseV1,
  AcceptSubmissionInput,
  AddArtifactRevisionInput,
  ApproveActionInput,
  CreateArtifactInput,
  CreateClaimInput,
  CreateSubmissionInput,
  ExecuteActionInput,
  RecordDeliveryReviewInput,
  RecordEvidenceInput,
  RecordIntegrationRunInput,
  RecordVerificationResultInput,
  RequestPullRequestActionInput,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";

type HumanCommand = {
  workspaceId: string;
  principalType: "user";
  principalId: string;
  idempotencyKey: string;
};

type ServiceCommand = Omit<HumanCommand, "principalType"> & {
  principalType: "service";
};

export interface CreateNativeTargetCommand extends HumanCommand {
  input: CreateTargetInputV1;
}

export interface CreateNativeGraphRevisionCommand extends HumanCommand {
  targetId: string;
  input: CreateGraphRevisionInputV1;
}

export interface ActivateNativeGraphRevisionCommand extends HumanCommand {
  targetId: string;
  graphRevisionId: string;
}

export interface CreateNativeRunCommand extends HumanCommand {
  targetId: string;
  graphRevisionId: string;
  workNodeId: string;
  input: CreateRunInputV1;
}

export interface CreateNativeRunAttemptCommand extends HumanCommand {
  runId: string;
  input: CreateRunAttemptInputV1;
}

export interface ReportNativeRunEventCommand extends ServiceCommand {
  runId: string;
  runAttemptId: string;
  input: ReportRunEventInputV1;
}

export interface RequestNativeRunCancellationCommand extends HumanCommand {
  runId: string;
}

export interface AssuranceCommandResponseV1 {
  schemaVersion: 1;
  resourceType: "artifact" | "artifact_revision" | "claim" | "evidence" | "verification_result";
  resourceId: string;
  replayed: boolean;
}

// Mirrors the Go AgentLifecycleResult written by the adjudication handlers
// in services/domain-api/internal/httpapi/server.go; keep in sync.
export interface AdjudicationCommandResponseV1 {
  schemaVersion: 1;
  resourceType: "submission" | "delivery_review" | "acceptance";
  resourceId: string;
  replayed: boolean;
}

// Mirrors the Go AgentLifecycleResult written by the connector handlers
// (recordConnectorIntegrationRun, requestConnectorPullRequestAction,
// approveConnectorAction, executeConnectorAction) in
// services/domain-api/internal/httpapi/server.go; keep in sync.
export interface ConnectorCommandResponseV1 {
  schemaVersion: 1;
  resourceType: "integration_run" | "action_request" | "action_approval" | "effect_receipt";
  resourceId: string;
  replayed: boolean;
}

export interface VerrailDomainApiClient {
  createTarget(command: CreateNativeTargetCommand): Promise<CreateTargetResponseV1>;
  createGraphRevision(command: CreateNativeGraphRevisionCommand): Promise<CreateGraphRevisionResponseV1>;
  activateGraphRevision(command: ActivateNativeGraphRevisionCommand): Promise<ActivateGraphRevisionResponseV1>;
  createRun(command: CreateNativeRunCommand): Promise<CreateRunResponseV1>;
  createRunAttempt(command: CreateNativeRunAttemptCommand): Promise<CreateRunAttemptResponseV1>;
  reportRunEvent(command: ReportNativeRunEventCommand): Promise<ReportRunEventResponseV1>;
  requestRunCancellation(command: RequestNativeRunCancellationCommand): Promise<RequestRunCancellationResponseV1>;
  createAgentDefinition(command: HumanCommand & { input: CreateAgentDefinitionInputV1 }): Promise<AgentLifecycleCommandResponseV1>;
  updateAgentDefinition(command: HumanCommand & { definitionId: string; input: UpdateAgentDefinitionInputV1 }): Promise<AgentLifecycleCommandResponseV1>;
  publishAgentVersion(command: HumanCommand & { definitionId: string; input: PublishAgentVersionInputV1 }): Promise<AgentLifecycleCommandResponseV1>;
  recordEvaluationRun(command: HumanCommand & { input: RecordEvaluationRunInputV1 }): Promise<AgentLifecycleCommandResponseV1>;
  createDeployment(command: HumanCommand & { input: CreateDeploymentInputV1 }): Promise<AgentLifecycleCommandResponseV1>;
  reviseDeployment(command: HumanCommand & { deploymentId: string; input: ReviseDeploymentInputV1 }): Promise<AgentLifecycleCommandResponseV1>;
  createArtifact(command: HumanCommand & { input: CreateArtifactInput }): Promise<AssuranceCommandResponseV1>;
  addArtifactRevision(command: HumanCommand & { input: AddArtifactRevisionInput }): Promise<AssuranceCommandResponseV1>;
  createClaim(command: HumanCommand & { input: CreateClaimInput }): Promise<AssuranceCommandResponseV1>;
  recordEvidence(command: HumanCommand & { input: RecordEvidenceInput }): Promise<AssuranceCommandResponseV1>;
  recordVerificationResult(command: HumanCommand & { input: RecordVerificationResultInput }): Promise<AssuranceCommandResponseV1>;
  createSubmission(command: HumanCommand & { input: CreateSubmissionInput }): Promise<AdjudicationCommandResponseV1>;
  recordDeliveryReview(command: HumanCommand & { input: RecordDeliveryReviewInput }): Promise<AdjudicationCommandResponseV1>;
  acceptSubmission(command: HumanCommand & { input: AcceptSubmissionInput }): Promise<AdjudicationCommandResponseV1>;
  recordIntegrationRun(command: HumanCommand & { input: RecordIntegrationRunInput }): Promise<ConnectorCommandResponseV1>;
  requestPullRequestAction(command: HumanCommand & { input: RequestPullRequestActionInput }): Promise<ConnectorCommandResponseV1>;
  approveAction(command: HumanCommand & { actionRequestId: string; input: ApproveActionInput }): Promise<ConnectorCommandResponseV1>;
  executeAction(command: HumanCommand & { actionRequestId: string; input: ExecuteActionInput }): Promise<ConnectorCommandResponseV1>;
}

type DomainApiErrorPayload = { error?: unknown; code?: unknown; retryable?: unknown };

export function createVerrailDomainApiClient(options: {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): VerrailDomainApiClient | null {
  const baseUrl = (options.baseUrl ?? process.env.VERRAIL_DOMAIN_API_URL ?? "").trim().replace(/\/$/, "");
  const token = (options.token ?? process.env.VERRAIL_DOMAIN_API_TOKEN ?? "").trim();
  if (!baseUrl || !token) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function send<T>(command: HumanCommand | ServiceCommand, path: string, body?: unknown, method = "POST"): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": command.idempotencyKey,
          "X-Verrail-Principal-Type": command.principalType,
          "X-Verrail-Principal-Id": command.principalId,
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw new HttpError(503, "Verrail Domain API is unavailable", {
        code: "TARGET_DOMAIN_API_UNAVAILABLE",
        retryable: true,
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
    const payload = await response.json().catch(() => ({})) as DomainApiErrorPayload | T;
    if (!response.ok) {
      const error = payload as DomainApiErrorPayload;
      throw new HttpError(response.status, typeof error.error === "string" ? error.error : "Domain command failed", {
        code: typeof error.code === "string" ? error.code : "DOMAIN_COMMAND_FAILED",
        retryable: error.retryable === true,
      });
    }
    return payload as T;
  }

  return {
    createTarget: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/targets`, command.input),
    createGraphRevision: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/targets/${encodeURIComponent(command.targetId)}/graph-revisions`, command.input),
    activateGraphRevision: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/targets/${encodeURIComponent(command.targetId)}/graph-revisions/${encodeURIComponent(command.graphRevisionId)}/activate`),
    createRun: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/targets/${encodeURIComponent(command.targetId)}/graph-revisions/${encodeURIComponent(command.graphRevisionId)}/nodes/${encodeURIComponent(command.workNodeId)}/runs`, command.input),
    createRunAttempt: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/runs/${encodeURIComponent(command.runId)}/attempts`, command.input),
    reportRunEvent: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/runs/${encodeURIComponent(command.runId)}/attempts/${encodeURIComponent(command.runAttemptId)}/events`, command.input),
    requestRunCancellation: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/runs/${encodeURIComponent(command.runId)}/cancel`),
    createAgentDefinition: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/agent-definitions`, command.input),
    updateAgentDefinition: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/agent-definitions/${encodeURIComponent(command.definitionId)}`, command.input, "PATCH"),
    publishAgentVersion: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/agent-definitions/${encodeURIComponent(command.definitionId)}/versions`, command.input),
    recordEvaluationRun: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/evaluation-runs`, command.input),
    createDeployment: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/deployments`, command.input),
    reviseDeployment: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/deployments/${encodeURIComponent(command.deploymentId)}/revisions`, command.input),
    createArtifact: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/artifacts`, command.input),
    addArtifactRevision: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/artifact-revisions`, command.input),
    createClaim: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/claims`, command.input),
    recordEvidence: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/evidence`, command.input),
    recordVerificationResult: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/verification-results`, command.input),
    createSubmission: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/submissions`, command.input),
    recordDeliveryReview: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/delivery-reviews`, command.input),
    acceptSubmission: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/acceptances`, command.input),
    recordIntegrationRun: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/integration-runs`, command.input),
    requestPullRequestAction: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/pull-request-actions`, command.input),
    approveAction: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/pull-request-actions/${encodeURIComponent(command.actionRequestId)}/approvals`, command.input),
    executeAction: (command) => send(command, `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/pull-request-actions/${encodeURIComponent(command.actionRequestId)}/executions`, command.input),
  };
}
