import type {
  AdjudicationAcceptanceV1,
  AdjudicationDeliveryReviewV1,
  AdjudicationSubmissionV1,
  AcceptSubmissionInput,
  ActivateGraphRevisionResponseV1,
  ApproveActionInput,
  AssuranceArtifactV1,
  AssuranceClaimV1,
  AssuranceEvidenceV1,
  AssuranceVerificationResultV1,
  ConversationDetail,
  CreateTargetInputV1,
  CreateTargetResponseV1,
  CreateRunAttemptInputV1,
  CreateRunAttemptResponseV1,
  CreateGraphRevisionInputV1,
  CreateGraphRevisionResponseV1,
  CreateRunInputV1,
  CreateRunResponseV1,
  ConnectorActionRequestV1,
  ConnectorEffectReceiptV1,
  ConnectorIntegrationRunV1,
  ExecuteActionInput,
  HumanWorkResultV1,
  RecordDeliveryReviewInput,
  RequestRunCancellationResponseV1,
  RetryRunOutboxInputV1,
  RetryRunOutboxResponseV1,
  RunOutboxFailureV1,
  TargetListResponseV1,
  TargetReadModelV1,
  TargetStatus,
  TargetWorkspaceV1,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Local extension of the shared TargetWorkspaceV1 contract: the server's
 * workspace read model replaces the legacy artifact/evidence/submission shapes
 * with the G2.3 Assurance facts and the G2.4 Adjudication facts. The shared
 * TargetWorkspaceV1 stays unchanged until the domain migration completes.
 */
export type TargetWorkspaceAssuranceFactsV1 = Omit<TargetWorkspaceV1, "artifacts" | "evidence" | "submissions"> & {
  criterionProofs: import("@paperclipai/shared").CriterionProofStatusV1[];
  submissions: AdjudicationSubmissionV1[];
  reviews: AdjudicationDeliveryReviewV1[];
  acceptances: AdjudicationAcceptanceV1[];
  artifacts: AssuranceArtifactV1[];
  claims: AssuranceClaimV1[];
  evidence: AssuranceEvidenceV1[];
  verificationResults: AssuranceVerificationResultV1[];
  integrationRuns: ConnectorIntegrationRunV1[];
  humanWorkResults: HumanWorkResultV1[];
  actionRequests: ConnectorActionRequestV1[];
  effectReceipts: ConnectorEffectReceiptV1[];
  workspaceBinding: { repoOwner: string; repoName: string } | null;
};

export interface TargetCommandResponseV1 {
  schemaVersion: 1;
  resourceType: string;
  resourceId: string;
  replayed: boolean;
}

export interface TargetListOptions {
  limit?: number;
  cursor?: string;
  collectionId?: string;
  status?: TargetStatus;
  ownerId?: string;
  attention?: boolean;
}

function listPath(workspaceId: string, options: TargetListOptions = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.collectionId) params.set("collectionId", options.collectionId);
  if (options.status) params.set("status", options.status);
  if (options.ownerId) params.set("ownerId", options.ownerId);
  if (options.attention !== undefined) params.set("attention", String(options.attention));
  const query = params.toString();
  return `/workspaces/${workspaceId}/targets${query ? `?${query}` : ""}`;
}

export const targetsApi = {
  reviseProof: (workspaceId: string, targetId: string, input: import("@paperclipai/shared").ReviseTargetProofInput, idempotencyKey: string) =>
    api.post<import("@paperclipai/shared").ReviseTargetProofResultV1>(`/workspaces/${workspaceId}/targets/${targetId}/revisions`, input, { headers: { "Idempotency-Key": idempotencyKey } }),
  runOutboxFailures: (workspaceId: string, targetId: string) =>
    api.get<RunOutboxFailureV1[]>(`/workspaces/${workspaceId}/targets/${targetId}/run-outbox-failures`),
  retryRunOutbox: (workspaceId: string, runId: string, input: RetryRunOutboxInputV1, idempotencyKey: string) =>
    api.post<RetryRunOutboxResponseV1>(`/workspaces/${workspaceId}/runs/${runId}/outbox/retry`, input, {
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  create: (workspaceId: string, input: CreateTargetInputV1, idempotencyKey: string) =>
    api.post<CreateTargetResponseV1>(`/workspaces/${workspaceId}/targets`, input, {
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  list: (workspaceId: string, options: TargetListOptions = {}) =>
    api.get<TargetListResponseV1>(listPath(workspaceId, options)),
  listForCollection: (workspaceId: string, collectionId: string, options: Omit<TargetListOptions, "collectionId"> = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.status) params.set("status", options.status);
    if (options.ownerId) params.set("ownerId", options.ownerId);
    if (options.attention !== undefined) params.set("attention", String(options.attention));
    const query = params.toString();
    return api.get<TargetListResponseV1>(
      `/workspaces/${workspaceId}/collections/${collectionId}/targets${query ? `?${query}` : ""}`,
    );
  },
  get: (workspaceId: string, targetId: string) =>
    api.get<TargetReadModelV1>(`/workspaces/${workspaceId}/targets/${targetId}`),
  getWorkspace: (workspaceId: string, targetId: string) =>
    api.get<TargetWorkspaceAssuranceFactsV1>(`/workspaces/${workspaceId}/targets/${targetId}/workspace`),
  createConversation: (workspaceId: string, targetId: string) =>
    api.post<ConversationDetail>(`/workspaces/${workspaceId}/targets/${targetId}/conversation`, {}),
  createGraphRevision: (
    workspaceId: string,
    targetId: string,
    input: CreateGraphRevisionInputV1,
    idempotencyKey: string,
  ) => api.post<CreateGraphRevisionResponseV1>(
    `/workspaces/${workspaceId}/targets/${targetId}/graph-revisions`,
    input,
    { headers: { "Idempotency-Key": idempotencyKey } },
  ),
  activateGraphRevision: (
    workspaceId: string,
    targetId: string,
    graphRevisionId: string,
    idempotencyKey: string,
  ) => api.post<ActivateGraphRevisionResponseV1>(
    `/workspaces/${workspaceId}/targets/${targetId}/graph-revisions/${graphRevisionId}/activate`,
    {},
    { headers: { "Idempotency-Key": idempotencyKey } },
  ),
  createRun: (
    workspaceId: string,
    targetId: string,
    graphRevisionId: string,
    workNodeId: string,
    input: CreateRunInputV1,
    idempotencyKey: string,
  ) => api.post<CreateRunResponseV1>(
    `/workspaces/${workspaceId}/targets/${targetId}/graph-revisions/${graphRevisionId}/nodes/${workNodeId}/runs`,
    input,
    { headers: { "Idempotency-Key": idempotencyKey } },
  ),
  createRunAttempt: (workspaceId: string, runId: string, input: CreateRunAttemptInputV1, idempotencyKey: string) =>
    api.post<CreateRunAttemptResponseV1>(`/workspaces/${workspaceId}/runs/${runId}/attempts`, input, {
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  requestRunCancellation: (workspaceId: string, runId: string, idempotencyKey: string) =>
    api.post<RequestRunCancellationResponseV1>(`/workspaces/${workspaceId}/runs/${runId}/cancel`, {}, {
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  recordDeliveryReview: (
    workspaceId: string,
    input: RecordDeliveryReviewInput,
    idempotencyKey: string,
  ) => api.post<TargetCommandResponseV1>(`/workspaces/${workspaceId}/delivery-reviews`, input, {
    headers: { "Idempotency-Key": idempotencyKey },
  }),
  acceptSubmission: (
    workspaceId: string,
    input: AcceptSubmissionInput,
    idempotencyKey: string,
  ) => api.post<TargetCommandResponseV1>(`/workspaces/${workspaceId}/acceptances`, input, {
    headers: { "Idempotency-Key": idempotencyKey },
  }),
  approveAction: (
    workspaceId: string,
    actionRequestId: string,
    input: ApproveActionInput,
    idempotencyKey: string,
  ) => api.post<TargetCommandResponseV1>(
    `/workspaces/${workspaceId}/pull-request-actions/${actionRequestId}/approvals`,
    input,
    { headers: { "Idempotency-Key": idempotencyKey } },
  ),
  executeAction: (
    workspaceId: string,
    actionRequestId: string,
    input: ExecuteActionInput,
    idempotencyKey: string,
  ) => api.post<TargetCommandResponseV1>(
    `/workspaces/${workspaceId}/pull-request-actions/${actionRequestId}/executions`,
    input,
    { headers: { "Idempotency-Key": idempotencyKey } },
  ),
  getRevision: (workspaceId: string, targetId: string, targetRevisionId: string) =>
    api.get<TargetReadModelV1>(
      `/workspaces/${workspaceId}/targets/${targetId}/revisions/${targetRevisionId}`,
    ),
};
