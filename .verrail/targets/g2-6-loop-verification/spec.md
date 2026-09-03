# G2.6 - Loop fault demonstrations and operational verification

## Objective

Prove the G2 exit gate on the live stack: the signature loop demonstrates
failure, retry, rejection, and invalidation with inspectable evidence; a
worker restart converges without human repair; repo bindings are
provisionable through governance.

## Design

### A) Four fault demonstrations (live stack, recorded evidence)

1. **Failure**: record an integration run with conclusion "failure" against a
   claim on the G2.5 runtime target — assert the claim flips to "refuted"
   and the evidence + failed verification result are recorded.
2. **Retry**: replay an identical governed command (same idempotency key) and
   assert the stored result replays (Replayed=true, no duplicate facts); then
   replay a run-event with a stale fencing token and assert the
   non-authoritative rejection is preserved in the audit trail.
3. **Rejection**: live demonstrations already gathered during G2.4/G2.5
   acceptance (self-review 403 ADJUDICATION_REVIEWER_NOT_INDEPENDENT,
   self-approve 403 CONNECTOR_APPROVER_NOT_INDEPENDENT, execute-pending 409
   CONNECTOR_ACTION_NOT_APPROVED) — re-run and record as a set.
4. **Invalidation**: supersede the accepted submission's target (a newer
   submission) and assert the read model renders the acceptance as invalid
   (superseded_submission) without mutating the acceptance fact.

### B) Worker kill-restart recovery (live stack)

1. Stop the orchestration worker process (kill the `go run` child).
2. Create a new target through the product API — the CreateTarget command
   writes the outbox event; with the dispatcher down the event stays
   "pending" and no Temporal workflow starts.
3. Assert: outbox event status pending, Temporal workflow absent, target
   state intact (the command path is worker-independent).
4. Restart the worker.
5. Assert: the event transitions to "delivered", the Temporal workflow for
   the new target exists and is running, and no human repair was needed.

### C) Repo-binding provisioning command (Go)

A governed admin command (CreateGithubRepoBinding) mirroring the established
receipt + audit pattern: admin-gated (the principal must be the workspace
outcome owner or an instance admin), params {connectionId, repoOwner,
repoName} validated (connection exists in workspace and enabled), one binding
per workspace (dedup replays), audit event connector.repo_binding_created.v1.
Route POST /v1/workspaces/{workspaceId}/github-repo-bindings + facade route +
OpenAPI. The connector ExecuteAction gate then accepts the provisioned
binding (CONNECTOR_NOT_BOUND no longer the terminal state for a provisioned
workspace).

### D) Credential wiring decision (surfaced, not implemented)

Documented options for GitHub token resolution, for the Outcome Owner:
1. Facade-delegated: the TypeScript facade resolves the connection credential
   through the existing Node secret service and passes the token to the
   Domain API as a per-command field (token transits once inside the
   bearer-protected internal link; never logged).
2. Domain-decrypted: export the secret decryption capability to the Go
   process (key distribution problem; larger surface).
3. GitHub App installation tokens (short-lived, revocable; larger build).
Recommendation: option 1 for G2 exit, option 3 as the G3+ target.

## Verification plan

- Demos A/B executed against the live stack (e985d7c1) with outputs recorded
  in runs/run-001/evidence.json.
- Provisioning command: Go unit + DB-gated integration tests mirroring the
  connector suite.
- Root pipeline, token gates.
