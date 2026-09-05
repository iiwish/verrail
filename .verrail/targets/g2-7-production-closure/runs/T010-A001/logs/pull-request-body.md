## Thinking Path

> - Verrail is an evidence-driven control plane for governed AI delivery.
> - G2 requires one complete delivery loop with immutable evidence and explicit human decisions.
> - The existing product had most domain facts, but the production loop still had gaps in orchestration, channel entry, external effects, and the operator workbench.
> - This pull request closes those gaps with version-bound facts, recoverable workflows, a Feishu connector, and a safe GitHub effect path.
> - The implementation keeps PostgreSQL authoritative and keeps provider credentials out of durable facts and logs.
> - The benefit is one inspectable path from Target creation to review, acceptance, and an exactly-once pull request.

## Linked Issues or Issue Description

The repository has disabled GitHub issues. No matching open or closed pull request exists.

**What existing behavior does this improve?**

This improves the native Target lifecycle, Graph and Temporal orchestration, assurance facts, Channel Connector host, GitHub Connector, Attention model, and Target Workbench.

**Subsystem affected**

Cross-cutting. The change affects the database, shared contracts, server, Go Domain API, plugin SDK, Feishu plugin, UI, and acceptance tests.

**Current behavior**

The prior baseline could record parts of a governed delivery. It could not prove one real, recoverable, operator-complete path from an enterprise message to an accepted Target and an exactly-once GitHub pull request.

**Proposed behavior**

Verrail accepts explicit Target creation through the shared channel contract. It runs version-bound work through durable orchestration. It records immutable artifacts, evidence, reviews, acceptance, action approval, and provider receipts. It reconciles uncertain GitHub effects before retry.

**Reason and benefit**

The change lets an operator inspect and control the full G2 delivery loop without direct database repair. It keeps human authority separate from agent and service submissions.

**Breaking changes**

None for supported callers. New fields and routes are additive. Stored pull-request actions without a body remain readable. Compatibility paths remain explicit during the domain migration.

## What Changed

- Added complete, version-bound work result, integration attempt, action, and provider receipt contracts.
- Added durable Target workflow coordination, retries, cancellation, recovery, and continue-as-new behavior.
- Added authenticated agent and service candidate commands while preserving human review, approval, and acceptance authority.
- Added the Feishu Channel Connector V1 slice with encrypted delivery, signature checks, user mapping, idempotency, and replies.
- Added short-lived GitHub credential transport, parameter-bound PR bodies, exactly-once effects, and unknown-effect reconciliation.
- Added Target Workbench commands, Attention states, timeline facts, and browser acceptance coverage.
- Reconciled prior G1 and G2 delivery records against repository and runtime evidence.

## Verification

- `pnpm test:domain-api`
- `pnpm --filter @paperclipai/db check:migrations`
- `pnpm -r typecheck`
- `pnpm check:token-gates`
- `pnpm test:run`
- `pnpm build`
- `pnpm test:e2e:verrail-acceptance`
- Real Feishu callback, inbound message, outbound reply, and delivery receipt verification.
- Real GitHub pull request, marker reconciliation, and EffectReceipt verification.
- API, worker, runner, and provider recovery exercises.

## Risks

- The change crosses multiple contracts and runtime processes. Full automated and real-provider verification limits this risk.
- Provider APIs can fail after an external effect succeeds. Stable markers and lookup-before-retry prevent duplicate pull requests.
- Feishu identity mapping can reject an unmapped user. The connector fails closed and requires an explicit active-user binding.
- Short-lived credentials cross one authenticated internal request. They are not stored in command bodies, workflow payloads, receipts, or logs.

## Model Used

OpenAI Codex with model `gpt-5.6-sol`. The Codex host managed the context window. The model used high-effort reasoning, repository tools, code execution, browser automation, and test execution.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked the canonical Verrail documents and confirmed this PR aligns with the product direction
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either linked existing issues or described the issue in the pull request with the matching template fields
- [x] I have not referenced internal or instance-local issues or links
- [x] My branch name describes the change and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented the risks above
- [x] All required Verrail CI gates are green locally
- [x] I will address all reviewer comments before requesting merge
