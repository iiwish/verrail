# G2.5 - GitHub connector, CI evidence, and PR action

## Objective

Complete the external half of the signature loop (product-goals G2): an
integration task produces CI evidence against acceptance criteria, and an
accepted delivery can create a pull request through a governed, approved
external action with an effect receipt.

## Product contract (confirmed defaults, Gate 2)

1. Integration runs are recorded through governed commands (no webhooks in
   this slice); CI evidence producers are service principals recorded by
   human members.
2. PR creation is an external Effect gated by: a parameter-bound approval
   (hash match), a valid derived acceptance on the LATEST submission of the
   target, and a bound GitHub connection. Approver must differ from the
   action requester.
3. The GitHub client sits behind an interface (fake in tests; thin REST
   wrapper for real use). Live GitHub acceptance is deferred to a
   user-provisioned environment.
4. Approver fine-grained RBAC stays in G4.

## Ontology bindings

- IntegrationTask nodes produce results or Evidence through IntegrationRun
  (ontology line 111, 240); external actions produce EffectReceipt and
  Evidence (line 242).
- Invariant 9: integration runs, action approvals, and effect receipts bind
  content or object hashes.
- Invariant 4: executed effect receipts are immutable.

## Design

New schema file `packages/db/src/schema/verrail_connector.ts` + migration
0241 (statement-reconcilable DDL only):

- `verrail_integration_runs`: id, workspace_id, target_id, claim_id
  (composite workspace FK to verrail_claims), work_node_id nullable
  (composite FK), provider ('github' check), external_ref text (run/check
  reference), conclusion ('success' | 'failure' | 'neutral' check),
  evidence_id (composite workspace FK to verrail_evidence),
  verification_result_id nullable (composite FK), created_by_principal_type/id,
  created_at. Immutable.
- `verrail_action_requests`: id, workspace_id, target_id, submission_id
  (composite workspace FK to verrail_submissions), action_type
  ('create_pull_request' check), params jsonb ({title, head, base}),
  params_hash (sha256 over canonical params), status
  ('pending_approval' | 'approved' | 'executed' check), requested_by_principal_type/id,
  created_at, updated_at (mutable status — the only mutable table in this
  slice; facts themselves are immutable).
- `verrail_action_approvals`: id, workspace_id, action_request_id (composite
  workspace FK), approved_by_principal_type/id, params_hash (must equal the
  request's), created_at. Immutable. Unique (action_request_id).
- `verrail_effect_receipts`: id, workspace_id, target_id, action_request_id
  (composite workspace FK), action_type, provider, external_object_id,
  external_url, effect_hash (sha256 over canonical request payload),
  payload jsonb, created_by_principal_type/id, created_at. Immutable.

Go Domain API commands (receipt + audit pattern; no outbox):

- RecordIntegrationRun: claim must exist in workspace; conclusion success →
  creates CI evidence (kind ci_result, producer service, trust high) + a
  verification result (verdict passed, verifier "integration-run.v1");
  failure → verdict failed; neutral → evidence only, no verification result.
  Run and evidence/verification facts written atomically.
- RequestPullRequestAction: submission must exist in workspace AND be the
  latest submission for the target AND its derived acceptance validity must
  be "valid" (reuse the shared deriveAcceptanceValidity rule); stores params
  jsonb + params_hash; status pending_approval.
- ApproveAction: approver must be a human member and must differ from the
  action requester (403 ADJUDICATION_APPROVER_NOT_INDEPENDENT);
  params_hash must match the request (409 CONNECTOR_PARAMS_HASH_MISMATCH);
  status pending_approval → approved. Unique (action_request_id).
- ExecuteAction: status must be approved (409 CONNECTOR_ACTION_NOT_APPROVED);
  an execute-time re-check re-derives the acceptance validity gate (the
  submission must still be the latest for the target and its revision must
  still be the target's active revision — 409 CONNECTOR_SUBMISSION_SUPERSEDED
  or ADJUDICATION_NOT_APPLICABLE); a GitHub connection must be bound for the
  workspace (409 CONNECTOR_NOT_BOUND when absent); calls the GitHubClient
  interface to create the PR; records the EffectReceipt + marks the action
  executed. Facade and store additionally bind the path action request id to
  the payload action request id (400 CONNECTOR_PATH_PAYLOAD_MISMATCH).

Deferrals recorded for this slice (review dispositions):

- Live GitHub acceptance against a real repository is deferred to a
  user-provisioned environment (connector is interface-bound, Fake-tested).
- The GitHub REST client's token injection is deferred: connection
  credentials are encrypted in the Node secret store and are not resolvable
  from the Go DB-only process; ExecuteAction surfaces
  CONNECTOR_CREDENTIALS_NOT_CONFIGURED until control-plane credential wiring
  lands (G2.6 / production).
- `verrail_github_repo_bindings` has no governed provisioning command or
  route yet — binding rows are provisioned out of band until a binding
  command lands (G2.6 / production).
- Upstream-crash reconciliation (a GitHub PR created but the transaction
  rolled back before the receipt committed) is recorded as a residual risk;
  invariant-15 style verification before blind replay is a G2.6 item.

GitHubClient interface (internal/target/connector.go):
- CreatePullRequest(ctx, input) (externalObjectID, externalURL, error)
- Real thin REST wrapper against api.github.com (repo from the connection
  binding; token from the workspace GitHub connection credential).
- Fake implementation used in tests.

Read model: workspace() gains integrationRuns, actionRequests, and
effectReceipts arrays (mapped per shared V1 types) with honest empty sets.

## Verification plan

- `pnpm db:generate` no-op; fresh-DB probe applies 0241.
- Go: unit tests (hash canonicality, independence, params-hash match, status
  rules) + DB-gated integration with the Fake connector covering: integration
  run → evidence + verification; PR action happy path (request → approve →
  execute → receipt); rejection paths (self-approval 403, hash mismatch 409,
  execute-before-approval 409, no-bound-connection 409, superseded submission
  409).
- Facade/read-model updates with tests; UI minimal (facts surface via the
  Evidence tab's evidence rows and the Timeline; no new tabs in this slice).
- Root pipeline, token gates, i18n parity.
