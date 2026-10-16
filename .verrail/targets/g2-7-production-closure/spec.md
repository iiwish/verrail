# G2.7 - Production Closure

Status: Confirmed by the Outcome Owner on 2026-09-04. Implementation has not started.

## Problem

G1 established the native Verrail Target surface and G2 added versioned agent,
execution, assurance, adjudication, connector, and recovery facts. The repository
still cannot honestly claim the G2 production exit gate:

- the live connector path cannot resolve GitHub credentials or prove a real PR
  effect;
- the Temporal workflows record signals but do not yet coordinate the full graph;
- IntegrationAttempt, HumanWorkResult, environment identity, and connector-version
  bindings are incomplete;
- the Workbench exposes much of the read model but not the complete governed write
  journey;
- the accepted signature loop has not been demonstrated with correctly separated,
  authenticated submitter, reviewer, requester, approver, and Outcome Owner roles;
- G1/G2 delivery records contain stale statuses and missing review references.

## Goal

Prove one real and recoverable delivery from explicit Target creation through a
pinned Codex execution, independent verification, immutable Submission, independent
DeliveryReview, Outcome Owner Acceptance, and an approved GitHub pull-request effect.
PostgreSQL facts must be sufficient to reconstruct the accepted state, and retries or
failures must not duplicate external effects.

## Product Contract

This target implements the current contracts in:

- `docs/product-goals.md`, G1 and G2 exit gates;
- `docs/product-design.md`, MVP scope and end-to-end acceptance;
- `docs/operational-ontology.md`, authority, version-binding, recovery, and external
  effect invariants;
- `docs/architecture.md`, PostgreSQL authority, Temporal boundaries, one-writer
  migration, and Go replatform limits.

Where inherited Paperclip behavior conflicts with these documents, the Verrail
contract wins and compatibility is preserved through an explicit migration path.

## Scope

1. Reconcile `.verrail` G1/G2 statuses, evidence links, review records, and runtime
   facts. Do not upgrade a status without evidence and the required authority.
2. Complete Web Chat plus one design-partner enterprise channel path from ordinary
   conversation to explicit, resumable TargetCreationDraft confirmation.
3. Complete the missing version-bound work result contracts, including
   IntegrationAttempt and HumanWorkResult, and bind runtime/environment facts needed
   for audit and replay.
4. Make TargetWorkflow the durable graph coordinator using Activities, child
   RunWorkflows, timers, retry, cancellation, gates, dependency activation, and a
   bounded Continue-As-New policy. PostgreSQL remains the business truth.
5. Add the user-facing commands and states needed to run, submit, review, accept,
   approve, execute, retry, cancel, and recover from the Target Workbench and
   Attention surfaces.
6. Resolve short-lived GitHub credentials across the TypeScript/Go boundary without
   persistence or disclosure, then execute the governed PR action against a real
   repository.
7. Add provider-effect reconciliation: before retrying an uncertain action, query by
   the canonical idempotency marker and converge to one EffectReceipt or an explicit
   UnknownEffect state.
8. Demonstrate the complete loop with authenticated principals and separately recorded
   authorities. A single human Outcome Owner may review, approve an external action,
   and accept when the Submission and ActionRequest are authored by authorized agent or
   service principals. Record inspectable evidence for normal, rejection, invalidation,
   retry, and component-failure paths.

## Non-goals

- Broad G3 Go replatforming or translation of mature TypeScript services.
- CubeSandbox production admission, Private Runner, Cloud fleet, SSO, SCIM, billing,
  or regional tenancy.
- More than one enterprise channel or SCM connector.
- Removing compatibility fields or old paths before usage reaches measured zero and
  the contract migration rollback is rehearsed.
- Shipping or releasing the product as part of this target.

## Constraints

- PostgreSQL domain facts are authoritative. Temporal History and agent transcripts
  are not business truth.
- A domain aggregate has one write owner during migration; long-lived dual writes are
  forbidden.
- Secrets use references or short-lived leases and never enter durable commands,
  logs, prompts, artifacts, receipts, or workflow payloads. An ephemeral internal
  request may carry a short-lived credential only after the boundary is approved and
  tests prove that the value is neither persisted nor logged.
- Fake connectors and manually seeded database facts may support tests but cannot
  satisfy production acceptance.
- Invocation, execution, review, action approval, and acceptance authority remain
  distinct and are derived from authenticated principals.
- Behavior changes use TDD. Each implementation slice requires a bounded execution
  packet, targeted verification, and evidence before the next dependent slice begins.
- Existing TypeScript compatibility, adapter, plugin, runtime, and rollback behavior
  must remain operable until its replacement slice passes reconciliation.

## Acceptance Criteria

1. **Delivery truth reconciled.** G1/G2 delivery records and runtime facts agree; every
   open or accepted state has a valid evidence and review trail.
2. **Real creation entry points.** Web Chat and one selected enterprise channel
   complete the same explicit Draft to versioned Target journey; ordinary messages do
   not create Targets.
3. **Pinned agent execution.** A pinned AgentVersion and DeploymentRevision execute
   real Codex work through a versioned GraphRevision and RunAttempt, record environment,
   log, cost, and permission facts, and produce a content-addressed artifact.
4. **Durable graph orchestration.** TargetWorkflow activates dependency-ready nodes and
   coordinates Activities, child workflows, timers, retry, gates, cancellation, and
   Continue-As-New without becoming the business-fact writer.
5. **Complete work result contracts.** IntegrationAttempt and HumanWorkResult are
   immutable, workspace-scoped, and bound to the relevant TargetRevision,
   GraphRevision, work node, authority, connector version, connection, environment,
   commit, criterion, provider receipt, and result as applicable.
6. **Independent assurance and acceptance.** CI produces Evidence and
   VerificationResult for the fixed inputs; an authenticated human independently
   reviews an immutable Submission authored by an authorized agent or service, and the
   Outcome Owner records Acceptance. The same human may hold reviewer and Outcome Owner
   authority, but Review and Acceptance remain separate commands. Self-review and
   non-owner acceptance remain rejected.
7. **Safe real GitHub effect.** An approved pull-request action resolves a short-lived
   credential, creates exactly one real PR, and records one immutable EffectReceipt.
   Provider timeouts and post-effect crashes converge by lookup-before-retry; uncertain
   outcomes remain explicit and never trigger a blind duplicate effect.
8. **Invalidation is enforced.** Changing any bound TargetRevision, Submission,
   artifact, verification input, or action parameter invalidates the stale decision and
   blocks execution.
9. **Product UI closes the loop.** The complete normal and recovery journeys are
   operable from Target Workbench and Attention without direct API calls or database
   modification, with honest loading, empty, error, retry, and rejection states.
10. **Failure recovery proven.** API, Temporal worker, runner, and provider failures
    recover without manual database repair; stale attempts cannot overwrite newer
    attempts; Target status reaches `accepted`; Timeline is reconstructible from
    PostgreSQL after the documented restart and restore exercises.
11. **Release gate is green.** Targeted tests, Go tests, workspace typecheck, full
    Vitest, production build, workflow replay, migration reconciliation, rollback
    checks, browser acceptance, independent review, and Outcome Owner acceptance all
    pass with linked evidence.

## Evidence Contract

The final evidence bundle must include:

- base and output commits, changed files, and command receipts for every slice;
- schema migration generation and fresh-database reconciliation results;
- Go unit, integration, race-sensitive where appropriate, workflow replay, and
  fault-recovery results;
- shared contract, facade, UI, i18n, typecheck, full Vitest, and production build
  results;
- screenshots of Target creation, graph/runs, artifact/evidence, Submission,
  Review/Acceptance, action approval, EffectReceipt, invalidation, and recovery states;
- the real GitHub PR reference and a redacted proof that credentials never entered a
  durable payload or log;
- an independent review decision and explicit Outcome Owner acceptance.

## 决策记录

1. **GitHub 凭证边界：已批准。** G2 采用 TypeScript facade 解析短期凭证，再通过
   已认证的内部请求临时传给 Go。凭证不得写入数据库、日志、领域命令回执或 Temporal
   Workflow History。GitHub App installation token 仍是 G3 的目标方案。
2. **首个企业通道：已批准选择飞书。** 这里的企业通道是指钉钉、飞书、企业微信等
   外部群聊或私聊入口。G2.7 只实现飞书，并复用统一的 ProviderConversationBinding 与
   TargetCreationDraft 合同。
3. **真人账号数量：一个真人可以满足 G2.7。** 独立性要求是 Reviewer 不能评审自己
   提交的 Submission，Approver 不能批准自己发起的 ActionRequest；并不要求 Reviewer、
   Approver 和 Outcome Owner 必须是三个不同的人。目标路径调整为由授权 Agent 或 Service
   创建 Submission 和 ActionRequest，同一个真人 Outcome Owner 可以依次执行 Review、
   Action Approval 和 Acceptance，但三种决定必须是独立命令、独立审计事实。当前实现把
   Submission 和 ActionRequest 的发起者固定为 user，这部分需要重构。不得通过创建虚假
   真人账号或由同一人冒充多个账号来满足生产证据。

## Approval Gate

The Outcome Owner confirmed this spec, the TypeScript-to-Go ephemeral credential
boundary, Feishu as the first enterprise channel, and the one-human authority model on
2026-09-04. Planning artifacts may be created. Implementation remains blocked until
the Outcome Owner separately approves the technical plan and work graph.
