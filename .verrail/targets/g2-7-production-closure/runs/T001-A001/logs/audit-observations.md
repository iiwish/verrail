# T001-A001 Audit Observations

Observed at: 2026-09-04T03:22:33Z
Base commit: `b46307dbd05a912c38a32395b88662952286fd58`
Branch: `codex/g2-7-production-closure`

## Repository records

- Parsed 11 G1/G2 `target.json` files successfully.
- Parsed 11 G1/G2 `timeline.jsonl` files successfully.
- Resolved all 6 unique commit IDs referenced by existing receipts to local Git commit objects.
- Verified 6 relevant merge commits are ancestors of HEAD.
- GitHub reported PR #2, #7, #10, #11, #12, and #13 as MERGED.
- No `ship-record.json` exists under the audited G1/G2 target directories.

## Missing or disconnected evidence

- `g2-0-stabilize-g1-baseline/runs/run-002/evidence.json` has no receipt.
- G2.3, G2.4, G2.5, and G2.6 run-001 evidence files have no receipts.
- G2.6 timeline references `reviews/independent-review.md`, but that file is absent.
- G2.4 timeline mentions `g24-evidence-tab-acceptance.png`, but no such file exists.
- G2.5 timeline mentions `g25-evidence-tab.md`; the file exists at repository root rather than under the target.
- G2.2 evidence still lists independent review as missing, while the later G2.0 combined independent review marks G2.2 SATISFIED.

## Current runtime

- `/api/health`: `status=ok`, commit matches HEAD, auth ready, database backup status ok.
- Current workspaces: 2.
- Workspace `c641493c-081c-4607-84ba-0818cd97981a`: 7 runtime Targets, all open/draft.
- G2.3 runtime active revision differs from its local target/evidence record.
- G2.4 runtime facts: artifact 1, claim 1, evidence 1, verification result 1, submission 1, review 0, acceptance 0.
- G2.5 runtime facts: artifact 1, claim 1, evidence 2, verification results 2, submission 1, integration run 1, action request 1, effect receipt 0.
- G2.6 runtime facts: artifact 1, claim 1, evidence 2, verification result 1, integration run 1, submission/review/acceptance/effect receipt 0.
- G2.7 runtime facts: no run, artifact, evidence, submission, review, acceptance, action request, or effect receipt.
- Historical Workspace IDs used by G1 domain, G2.0, G2.1, and G2.2 are absent from the current database.

## Source observations

- `adjudication_store.go:78` writes Submission principal type as `user`.
- `connector_store.go:165` writes ActionRequest principal type as `user`.
- `orchestration/workflow.go` uses Signal, Query, deduplication, and Continue-As-New but no Activity, Child Workflow, or Timer.
- `connector_store.go:313-346` calls GitHub inside the DB transaction and only then writes EffectReceipt; there is no UnknownEffect reconciliation.
- No IntegrationAttempt, HumanWorkResult, generic ChannelConnector, Feishu, or Lark implementation was found in source paths.
- Target Workbench exposes Run start/retry/cancel commands; no Submission, Review, Acceptance, Action Approval, or Effect execution UI command was found.
