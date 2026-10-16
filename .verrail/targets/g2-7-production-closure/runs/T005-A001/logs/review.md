# T005 Technical Review

## Spec Compliance

- PostgreSQL remains authoritative for TargetRevision, GraphRevision, WorkNode, Run, RunAttempt, ExecutionLease, command receipts, audit, and outbox facts.
- Workflow code performs no SQL or provider calls. Registered Activities invoke validated Store commands with service Principals and stable idempotency keys.
- Graph Engine is the only writer that moves dependency-ready nodes from `pending` to `ready`; result commands retain terminal-state authority.
- Agent Runs bind the active DeploymentRevision and AgentVersion already enforced by CreateRun.
- Workflow, child, Activity, and command identities are deterministic and Workspace-scoped where required.
- Workflow payloads contain identifiers, counters, timestamps, and bounded state only; no credential, prompt, log, Artifact body, or Provider receipt is carried.

## Reliability Review

- Activity retry reuses the same Activity ID and domain idempotency key.
- A recovery check cannot duplicate a live Attempt and honors heartbeat-extended database expiry.
- Expired Attempt recovery increments fencing; old signals and executor events cannot overwrite the newer Attempt.
- Continue-As-New carries the minimum orchestration state and bounded event ID history.
- `GetVersion` protects pre-T005 Target and Run histories.
- Real Temporal restart tests prove both workflows resume and their completed histories replay.
- Cancellation does not declare terminal completion before the Runner termination fact.

## Decision

No Critical or High implementation finding remains. T005 is technically accepted for dependency progression under the delegated gate. This is not final Outcome Owner acceptance and does not create a ship record.

## Residual Risk

Production Temporal clustering and remote/isolated Runner fleet behavior are not represented by the pinned local development server and remain outside this task's HostTrusted boundary.
