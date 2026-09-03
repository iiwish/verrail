export const CONNECTOR_SCHEMA_VERSION = 1 as const;

export const CONNECTOR_PROVIDERS = ["github"] as const;

export const CONNECTOR_ACTION_TYPES = ["create_pull_request"] as const;

export const CONNECTOR_ACTION_STATUSES = ["pending_approval", "approved", "executed"] as const;

export const CONNECTOR_CONCLUSIONS = ["success", "failure", "neutral"] as const;

export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];
export type ConnectorActionType = (typeof CONNECTOR_ACTION_TYPES)[number];
export type ConnectorActionStatus = (typeof CONNECTOR_ACTION_STATUSES)[number];
export type ConnectorConclusion = (typeof CONNECTOR_CONCLUSIONS)[number];

export interface ConnectorPrincipalV1 {
  principalType: string;
  principalId: string;
}

export interface ConnectorPullRequestParamsV1 {
  title: string;
  head: string;
  base: string;
}

/**
 * Immutable integration run: one IntegrationTask result bound to the CI
 * evidence it produced and the verification result it asserted (ontology
 * 111, 240; invariant 9). Neutral runs carry no verification result.
 */
export interface ConnectorIntegrationRunV1 {
  id: string;
  targetId: string;
  claimId: string;
  workNodeId: string | null;
  provider: ConnectorProvider;
  externalRef: string;
  conclusion: ConnectorConclusion;
  evidenceId: string;
  verificationResultId: string | null;
  createdBy: ConnectorPrincipalV1;
  createdAt: string;
}

export interface ConnectorActionApprovalSummaryV1 {
  count: number;
  latest: {
    id: string;
    approvedBy: ConnectorPrincipalV1;
    paramsHash: string;
    createdAt: string;
  } | null;
}

export interface ConnectorExecutedReceiptSummaryV1 {
  id: string;
  effectHash: string;
  externalObjectId: string;
  externalUrl: string;
  createdAt: string;
}

/**
 * Governed external action request. Immutable except `status`
 * (pending_approval -> approved -> executed); approvals and the executed
 * receipt are surfaced as derived summaries.
 */
export interface ConnectorActionRequestV1 {
  id: string;
  targetId: string;
  submissionId: string;
  actionType: ConnectorActionType;
  params: ConnectorPullRequestParamsV1;
  paramsHash: string;
  status: ConnectorActionStatus;
  requestedBy: ConnectorPrincipalV1;
  createdAt: string;
  updatedAt: string;
  approvals: ConnectorActionApprovalSummaryV1;
  executedReceipt: ConnectorExecutedReceiptSummaryV1 | null;
}

/**
 * Immutable receipt of one executed external Effect (ontology 242;
 * invariant 4). Created only after a parameter-bound approval and a
 * successful upstream call.
 */
export interface ConnectorEffectReceiptV1 {
  id: string;
  targetId: string;
  actionRequestId: string;
  actionType: ConnectorActionType;
  provider: ConnectorProvider;
  externalObjectId: string;
  externalUrl: string;
  effectHash: string;
  payload: Record<string, unknown>;
  createdBy: ConnectorPrincipalV1;
  createdAt: string;
}

export interface ConnectorTargetFactsV1 {
  schemaVersion: typeof CONNECTOR_SCHEMA_VERSION;
  integrationRuns: ConnectorIntegrationRunV1[];
  actionRequests: ConnectorActionRequestV1[];
  effectReceipts: ConnectorEffectReceiptV1[];
}
