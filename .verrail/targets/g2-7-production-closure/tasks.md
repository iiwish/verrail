# G2.7 Post-Spec Work Graph

Version: v1.0
Status: Confirmed by the Outcome Owner on 2026-09-04
Source spec: `.verrail/targets/g2-7-production-closure/spec.md` (Confirmed)
Source plan: `.verrail/targets/g2-7-production-closure/plan.md`
Last updated: 2026-09-04

## 状态规则

- T001 已获授权并进入 Ready。
- 每个后续任务只有在依赖通过证据和技术 review、packet 完整且 analysis 无阻塞项时才能进入 Ready。
- 一次只执行一个 governed task；本工作图不授权自动并行或再次委派。
- Outcome Owner 已委托 Codex 自行批准后续技术计划闸门；最终真人治理决定和目标验收不在委托范围内。

## 工作图

### Epic E001：建立可信基线

User outcome:
后续实现基于可复核的真实进度，而不是陈旧状态或缺失证据。

Tasks:
- [x] T001 [AC-01, AC-11] 建立交付证据与领域不变量差距矩阵
- [x] T002 [AC-01, AC-11] 对账交付记录并稳定仓库验证基线

### Epic E002：补齐领域与编排合同

User outcome:
一个真人可以治理 Agent/Service 提交的候选，每类工作都有版本固定、可恢复的权威事实。

Tasks:
- [x] T003 [AC-03, AC-06, AC-08] 分离候选发起身份和人类治理权限
- [x] T004 [AC-03, AC-05, AC-06] 增加完整工作结果与版本绑定
- [x] T005 [AC-04, AC-10] 实现主动且可恢复的 Graph/Temporal 编排

### Epic E003：关闭外部 Effect 与原生产品合同

User outcome:
系统可以安全调用真实 GitHub，并从原生 Target 事实展示下一步动作和最终结果。

Tasks:
- [x] T006 [AC-07, AC-08, AC-10] 实现短期 GitHub 凭证与 UnknownEffect 对账
- [x] T007 [AC-06, AC-07, AC-08, AC-09] 收口 Target 状态、命令、Timeline、Outcome 与 Attention

### Epic E004：完成入口和操作面

User outcome:
用户可从飞书或 Web Chat 创建 Target，并在 Workbench 内完成整个治理闭环。

Tasks:
- [x] T009 [AC-02, AC-09] 实现飞书 Channel Connector 纵向切片
- [x] T008 [AC-06, AC-07, AC-08, AC-09] 完成 Target Workbench 和 Home 操作闭环

### Epic E005：生产验收

User outcome:
真实 GitHub、飞书和故障恢复证据证明 G2 可以结束。

Tasks:
- [x] T011 [AC-04, AC-10] 修复并发 max-turn continuation 幂等收敛
- [x] T012 [AC-02, AC-11] 补齐 Channel Connector webhook OpenAPI 契约
- [x] T013 [AC-11] 隔离 OpenCode 环境诊断测试的主机配置
- [x] T014 [AC-07, AC-08, AC-11] 让受治理的 GitHub PR 携带完整、审批绑定的正文
- [x] T015 [AC-03, AC-09] 让工作台绑定真实活跃 DeploymentRevision
- [x] T016 [AC-03, AC-04, AC-10] 将原生 RunAttempt 接入可信 Codex 执行器
- [x] T017 [AC-03, AC-11] 阻止未通过评估的 Deployment 被恢复
- [x] T018 [AC-03, AC-10] 校验版本模型与提示词执行快照
- [x] T019 [AC-03, AC-10, AC-11] 让 Codex ACP 使用受管运行时二进制
- [ ] T010 [AC-01..AC-11] 执行真实闭环、独立评审和 Outcome Owner 验收

## Task Details

### T001：建立交付证据与领域不变量差距矩阵

Status: Accepted for dependency progression under delegated technical gate
Priority: P0
Depends on: None
Blocks: T002
Story / Requirement: E001, AC-01, AC-11
Parallel: No
Conflicts with: None

目标:
逐个核对 G1、G2.0 至 G2.6 的 target、timeline、run evidence、review、Git commit、运行时 Target
和 `docs/operational-ontology.md` 不变量，形成一份只陈述已观察事实的关闭矩阵。

允许修改范围:
- `.verrail/targets/g2-7-production-closure/gap-matrix.md`
- `.verrail/targets/g2-7-production-closure/runs/T001-A001/**`
- `.verrail/targets/g2-7-production-closure/timeline.jsonl`

Test targets:
- 所有 `.verrail/targets/*/target.json` 和 `timeline.jsonl` 仅作为输入读取。

交付内容:
- 每个历史目标的 status/evidence/review/runtime 一致性表。
- AC-01 至 AC-11 与系统不变量的 implemented/partial/missing 映射。
- T002 允许修复的确切记录列表；不修改历史 accepted 决定。

Definition of Done:
- 每个判断都有文件、commit、命令或运行时引用；未观察到的证据标记为 missing。
- `gap-matrix.md` 不把测试 fixture、fake connector 或手工 seed 当生产验收。

验证命令:
- `jq -e . .verrail/targets/*/target.json`
- `git diff --check`
- 逐项验证矩阵引用的本地文件存在。

TDD plan:
- 不适用：本任务只生成审计 artifact，不改变产品行为。

Packet path:
- `.verrail/targets/g2-7-production-closure/execution-packet.json`

Evidence required:
- 输入清单、发现数量、引用校验结果、changed files、diff summary、residual risks。

### T002：对账交付记录并稳定仓库验证基线

Status: Accepted for dependency progression under delegated technical gate
Priority: P0
Depends on: T001 Accepted
Blocks: T003, T004, T009
Story / Requirement: E001, AC-01, AC-11
Parallel: No
Conflicts with: T003, T004, T009

目标:
只依据 T001 证据修复 G1/G2 记录中的状态、缺失引用和事实漂移，并让当前 HEAD 的全量验证结果可重复。

允许修改范围:
- T001 矩阵明确列出的 `.verrail/targets/g1-*`、`.verrail/targets/g2-*` 记录文件。
- `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`
- `server/src/services/heartbeat.ts`，仅当 RED 证明是产品竞态而非测试隔离问题。
- `scripts/run-vitest-stable.mjs` 与 `scripts/__tests__/run-vitest-stable-shard.test.mjs`，仅用于修复全量测试已证明的临时目录泄漏。
- `.verrail/targets/g2-7-production-closure/runs/T002-A001/**`
- `.verrail/targets/g2-7-production-closure/timeline.jsonl`

Test targets:
- `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`

验收标准:
- 不补写不存在的 review，不替用户批准旧目标，不重写 append-only timeline。
- 全量失败能够稳定复现并修复，或被证明为环境问题且有可执行隔离方案。

验证命令:
- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-stale-queue-invalidation.test.ts`
- `pnpm test:run`
- `pnpm -r typecheck`
- `git diff --check`

TDD plan:
- RED: 稳定复现竞态或隔离泄漏，保存失败状态和预期终态。
- GREEN: 修复最小产品竞态或测试生命周期问题。
- REFACTOR: 只在测试保持绿色后整理重复 setup/cleanup。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T002.json`

Evidence required:
- 前后状态对账、RED/GREEN 结果、全量 suite 结果、未改变的用户决定、残余风险。

### T003：分离候选发起身份和人类治理权限

Status: Accepted for dependency progression under delegated technical gate
Priority: P0
Depends on: T002 Accepted
Blocks: T004, T006, T007
Story / Requirement: E002, AC-03, AC-06, AC-08
Parallel: No
Conflicts with: T004, T006, T007

目标:
允许受认证的 Agent/Service 发起 Submission 与 ActionRequest，同时保持人类 Review、Approval、Acceptance 的身份绑定和独立命令边界。

允许修改范围:
- `services/domain-api/internal/target/adjudication.go`
- `services/domain-api/internal/target/adjudication_store.go`
- `services/domain-api/internal/target/adjudication_test.go`
- `services/domain-api/internal/target/connector.go`
- `services/domain-api/internal/target/connector_store.go`
- `services/domain-api/internal/target/connector_test.go`
- `services/domain-api/internal/httpapi/server.go`
- `server/src/services/verrail-domain-api-client.ts`
- `server/src/services/verrail-domain-api-client.test.ts`
- `server/src/routes/adjudication.ts`
- `server/src/routes/connector.ts`
- 对应的 route tests、shared adjudication/connector types 与 validators。

Test targets:
- Go adjudication/connector integration tests。
- TypeScript domain client、adjudication route、connector route tests。

验收标准:
- principal 只能由认证边界决定，body 不能伪造 Agent/Service。
- 一个真人能评审 Agent/Service Submission、批准 Agent/Service ActionRequest 并作为 owner 验收。
- 同一 user 自提自审、自请自批和非 owner 验收继续被拒绝。

验证命令:
- `pnpm test:domain-api`
- 对应 server/shared focused tests。
- `pnpm -r typecheck`
- `git diff --check`

TDD plan:
- RED: 增加 service 发起成功与 principal spoof/self-approval 拒绝测试。
- GREEN: 最小扩展 command principal 和存储写入。
- REFACTOR: 收敛 HumanCommand/ServiceCommand 类型，不放宽无关命令。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T003.json`

Evidence required:
- 权限矩阵、拒绝码、receipt/audit principal、RED/GREEN、threat notes。

### T004：增加完整工作结果与版本绑定

Status: Accepted for dependency progression under delegated technical gate
Priority: P0
Depends on: T003 Accepted
Blocks: T005, T006, T007
Story / Requirement: E002, AC-03, AC-05, AC-06
Parallel: No
Conflicts with: T005, T006, T007

目标:
增加 IntegrationAttempt、HumanWorkResult，并让 IntegrationRun 固定 ConnectorVersion、Connection、GraphRevision、Commit、Criterion、Environment 和 Provider Receipt。

允许修改范围:
- `packages/db/src/schema/verrail_connector.ts`
- `packages/db/src/schema/verrail_delivery.ts`
- `packages/db/src/schema/verrail_execution.ts`
- `packages/db/src/schema/verrail_work_results.ts`（新文件）。
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/**`（仅生成的下一份 migration、journal 和 snapshot）。
- `packages/shared/src/types/connector.ts`
- `packages/shared/src/types/target.ts`
- `packages/shared/src/validators/connector.ts`
- `packages/shared/src/index.ts`
- `services/domain-api/internal/target/connector.go`
- `services/domain-api/internal/target/connector_store.go`
- `services/domain-api/internal/target/connector_test.go`
- `services/domain-api/internal/httpapi/server.go`
- `server/src/services/target-read-model.ts`
- 对应 schema/shared/read-model tests。

验收标准:
- 新事实 Workspace-scoped、不可变、有复合外键、状态 CHECK、幂等键和版本绑定。
- 旧行使用明确兼容语义；migration 不伪造未知版本或结果。
- 不同节点类型不能用另一类结果事实完成。

验证命令:
- `pnpm db:generate`
- `pnpm --filter @paperclipai/db check:migrations`
- `pnpm test:domain-api`
- focused shared/read-model tests。
- `pnpm -r typecheck`

TDD plan:
- RED: 先增加跨 Workspace、缺失版本、错误节点类型、重复 attempt 和不可变性测试。
- GREEN: 最小 schema、commands 和 read model。
- REFACTOR: 统一版本绑定查询和 hash 生成。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T004.json`

Evidence required:
- migration reconciliation、schema constraints、command tests、read-model proof、residual compatibility risk。

### T005：实现主动且可恢复的 Graph/Temporal 编排

Status: Accepted for dependency progression under delegated technical gate
Priority: P0
Depends on: T004 Accepted
Blocks: T006, T007, T010
Story / Requirement: E002, AC-04, AC-10
Parallel: No
Conflicts with: T006, T007

目标:
让 TargetWorkflow/RunWorkflow 主动协调领域命令、依赖节点、Gate、Timer、Retry、Cancellation 和 Continue-As-New，同时保持 Graph Engine 的状态裁决权。

允许修改范围:
- `services/domain-api/internal/orchestration/**`
- `services/domain-api/internal/target/graph.go`
- `services/domain-api/internal/target/graph_store.go`
- `services/domain-api/internal/target/execution.go`
- `services/domain-api/internal/target/execution_store.go`
- `services/domain-api/internal/httpapi/server.go`
- `docs/temporal-target-workflow.md`，仅记录最终实现合同。
- 对应 Go workflow、replay、DB integration tests 和 fixtures。

验收标准:
- 依赖满足后节点只激活一次；child workflow ID 稳定；Activity 重试不重复领域事实。
- Worker/API 重启可恢复；cancel/timeout/lease expiry 收敛；旧 attempt 不能覆盖新 attempt。
- Workflow replay 和 Continue-As-New 保持确定性。

验证命令:
- `pnpm test:domain-api`
- Go workflow replay tests 与 fault matrix。
- `pnpm -r typecheck`
- `git diff --check`

TDD plan:
- RED: dependency、duplicate signal、worker restart、timer、cancel、stale fence 和 replay cases。
- GREEN: 最小 Activities/child workflows/domain commands。
- REFACTOR: green 后收敛 workflow state 和 version gates。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T005.json`

Evidence required:
- Workflow histories、replay results、fault results、PG facts、duplicate protection。

### T006：实现短期 GitHub 凭证与 UnknownEffect 对账

Status: Accepted for dependency progression under delegated technical gate
Priority: P0
Depends on: T005 Accepted
Blocks: T007, T008, T010
Story / Requirement: E003, AC-07, AC-08, AC-10
Parallel: No
Conflicts with: T007, T008

目标:
安全解析 GitHub 短期凭证，并用显式 Effect 状态机和 lookup-before-retry 保证真实 PR 最多产生一次。

允许修改范围:
- `server/src/routes/connector.ts`
- `server/src/services/verrail-domain-api-client.ts`
- `server/src/services/secrets.ts`
- `server/src/services/run-secret-redaction.ts`
- `packages/shared/src/types/connector.ts`
- `packages/shared/src/validators/connector.ts`
- `packages/db/src/schema/verrail_connector.ts`
- `packages/db/src/migrations/**`（仅本任务生成的 migration 元数据）。
- `services/domain-api/internal/target/connector.go`
- `services/domain-api/internal/target/connector_store.go`
- `services/domain-api/internal/target/connector_test.go`
- `services/domain-api/internal/httpapi/server.go`
- 对应 server/shared security tests。

验收标准:
- credential 只存在于单次内部请求和 GitHub client 内存中；持久事实和日志扫描无 sentinel。
- 超时、断连、Go crash 和 DB commit failure 均先核验 Provider，再形成 receipt、重试或保留 UnknownEffect。
- params hash、repo binding、acceptance validity 和审批在执行时再次检查。

验证命令:
- focused secret/connector/redaction tests。
- `pnpm test:domain-api`
- `pnpm -r typecheck`
- `pnpm test:run`
- `git diff --check`

TDD plan:
- RED: credential leakage、post-effect crash、timeout lookup、duplicate retry、stale approval tests。
- GREEN: ephemeral credential bridge 和 Effect reconciliation。
- REFACTOR: 将 provider lookup/create 保持在 Connector port 后。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T006.json`

Evidence required:
- redacted request proof、sentinel scan、provider fake fault matrix、真实 GitHub 前置条件清单。

### T007：收口 Target 状态、命令、Timeline、Outcome 与 Attention

Status: Accepted for dependency progression
Priority: P0
Depends on: T006 Accepted
Blocks: T008, T010
Story / Requirement: E003, AC-06, AC-07, AC-08, AC-09
Parallel: No
Conflicts with: T008

目标:
由 PostgreSQL 原生事实推导 Target 状态、Outcome、Timeline 和 Attention，并提供 UI 所需的治理命令合同。

允许修改范围:
- `packages/db/src/schema/verrail_targets.ts`
- `packages/db/src/schema/verrail_adjudication.ts`
- `packages/db/src/schema/verrail_connector.ts`
- `packages/db/src/migrations/**`（仅本任务生成的 migration 元数据）。
- `packages/shared/src/types/target.ts`
- `packages/shared/src/types/attention.ts`
- 对应 shared validators 与 exports。
- `services/domain-api/internal/target/model.go`
- `services/domain-api/internal/target/store.go`
- `services/domain-api/internal/httpapi/server.go`
- `server/src/services/target-read-model.ts`
- `server/src/services/attention.ts`
- `server/src/routes/targets.ts`
- `server/src/routes/attention.ts`
- `server/src/routes/openapi.ts`
- 对应 Go/server/read-model/OpenAPI tests。

验收标准:
- 状态转换有 DB/领域约束；accepted 只能由有效 Acceptance 推导或裁决。
- 新 revision/submission/content hash 变化产生失效 Attention，不能保留陈旧绿态。
- Home 不依赖 Issue/Heartbeat 作为 Target Outcome 的事实源。

验证命令:
- focused Go/server/shared tests。
- `pnpm test:domain-api`
- `pnpm -r typecheck`
- `pnpm check:token-gates`
- `git diff --check`

TDD plan:
- RED: accepted/invalidated/blocked/attention projection 和非法转换测试。
- GREEN: 最小命令、约束和投影。
- REFACTOR: 收敛重复 validity/attention 推导函数。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T007.json`

Evidence required:
- 状态矩阵、重建查询、OpenAPI parity、native-only read proof、invalidation evidence。

### T009：实现飞书 Channel Connector 纵向切片

Status: Accepted for dependency progression
Priority: P1
Depends on: T007 Accepted
Blocks: T008, T010
Story / Requirement: E004, AC-02, AC-09
Parallel: No
Conflicts with: T008

目标:
通过版本化共享 Channel Connector 合同接入飞书群聊/私聊消息、会话绑定、回复和显式 Target Draft 确认。

允许修改范围:
- `packages/shared/src/types/channel.ts`（新文件）。
- `packages/shared/src/validators/channel.ts`（新文件）。
- `packages/shared/src/index.ts`
- `packages/shared/src/types/plugin.ts`
- `packages/shared/src/validators/plugin.ts`
- `packages/plugins/sdk/src/**`（仅 Channel Connector host contract 与 tests）。
- `packages/plugins/channel-connectors/feishu/**`（新 package）。
- `server/src/services/channel-connector-host.ts`（新文件）。
- `server/src/services/conversation-target-drafts.ts`
- `server/src/routes/plugins.ts`
- `server/src/app.ts`
- 对应 plugin/webhook/conversation tests、workspace package metadata 和 lockfile。

验收标准:
- 验签/解密失败默认拒绝，event ID 幂等，跨 Workspace/Connection/Conversation 被拒绝。
- 普通消息只进入 Conversation；明确意图创建可恢复 Draft；最终确认需要授权真人。
- provider 原始标识和技术诊断不被错误翻译或写入 Target 语义。

验证命令:
- focused shared/plugin/server conversation tests。
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm check:token-gates`
- 飞书 sandbox webhook/回信验收。

TDD plan:
- RED: challenge、签名错误、重放、群聊/私聊绑定、普通消息、显式创建和权限拒绝测试。
- GREEN: 最小 Channel Connector port、host bridge 和 Feishu plugin。
- REFACTOR: provider payload 只留在 adapter，core 使用规范化事件。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T009.json`

Evidence required:
- contract tests、webhook security matrix、sandbox delivery IDs、Conversation/Draft runtime facts。

### T008：完成 Target Workbench 和 Home 操作闭环

Status: Accepted for dependency progression
Priority: P1
Depends on: T009 Accepted
Blocks: T010
Story / Requirement: E004, AC-06, AC-07, AC-08, AC-09
Parallel: No
Conflicts with: T009

目标:
让用户从 Web Chat、Target Workbench 和 Home 完成运行、提交、评审、验收、批准、执行、取消、重试和恢复，不使用直接 API 或数据库操作。

允许修改范围:
- `ui/src/pages/VerrailChat.tsx`
- `ui/src/pages/TargetWorkbench.tsx`
- `ui/src/pages/VerrailHome.tsx`
- `ui/src/pages/Targets.tsx`
- `ui/src/components/NewTargetDialog.tsx`
- `ui/src/components/AttentionQueueRow.tsx`
- `ui/src/components/VerrailConversationSidebar.tsx`
- `ui/src/api/conversations.ts`
- `ui/src/api/targets.ts`
- `ui/src/api/attention.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/i18n/locales/**`
- 对应 UI tests 与 `tests/verrail-acceptance/**`。

验收标准:
- 每个命令显示 pending/success/error/retry/rejection，且不会通过 optimistic UI 伪造权威状态。
- Review、Approval、Acceptance 明确展示不同决定及其绑定 hash/版本。
- 所有桌面支持宽度无文本遮挡，键盘焦点和非颜色状态可用，中英文 parity 通过。

验证命令:
- focused UI tests。
- `pnpm -r typecheck`
- `pnpm check:token-gates`
- `pnpm build`
- `pnpm test:e2e:verrail-acceptance`

TDD plan:
- RED: 为每个命令状态、失效、权限拒绝和错误恢复增加组件/API tests。
- GREEN: 最小 UI 和 API client wiring。
- REFACTOR: 共享命令状态组件，避免嵌套 card 和旧语义泄漏。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T008.json`

Evidence required:
- UI tests、i18n parity、desktop screenshots、browser journey、console/network errors。

### T010：执行真实闭环、独立评审和 Outcome Owner 验收

Status: Waiting for T023 real Feishu long-connection acceptance
Priority: P0
Depends on: T005, T006, T007, T008, T009 Accepted
Blocks: G2 completion
Story / Requirement: E005, AC-01..AC-11
Parallel: No
Conflicts with: All implementation tasks

目标:
在真实飞书应用和真实 GitHub 测试仓库完成正常、拒绝、失效、重试、API/Worker/Runner/Provider 故障与恢复旅程，并形成完整交付证据。

允许修改范围:
- `.verrail/targets/g2-7-production-closure/runs/T010-A001/**`
- `.verrail/targets/g2-7-production-closure/reviews/**`
- `.verrail/targets/g2-7-production-closure/target.json`
- `.verrail/targets/g2-7-production-closure/timeline.jsonl`
- `tests/verrail-acceptance/**`，仅补充已实现旅程的稳定验收脚本。
- 如发现产品缺陷，停止本任务并生成独立 fix packet，不直接扩大 allowed files。

External prerequisites:
- 已配置的飞书测试应用、webhook 与可操作群聊或私聊。
- 用户授权的 GitHub 测试仓库、连接 Secret 和允许创建 PR 的分支。

验收标准:
- 真实 PR 恰好一个，EffectReceipt 与外部对象一致，无 Secret 泄漏。
- 同一真人完成独立 Review、Action Approval 和 Acceptance；候选由 Agent/Service 发起。
- Target 从 PostgreSQL 重建为 accepted，重启和恢复后保持有效。
- 全部 AC 和 evidence contract 被独立 reviewer 覆盖。

验证命令:
- `pnpm test:domain-api`
- `pnpm --filter @paperclipai/db check:migrations`
- `pnpm -r typecheck`
- `pnpm check:token-gates`
- `pnpm test:run`
- `pnpm build`
- `pnpm test:e2e:verrail-acceptance`
- 真实飞书/GitHub 手工验收与 fault/restore runbook。
- `git diff --check`

TDD plan:
- RED/GREEN 已由前置 implementation tasks 完成；本任务执行验收和故障注入，不新增产品实现。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T010.json`

Evidence required:
- 完整 command log、测试结果、screenshots、PR URL、redacted secret scan、fault timeline、独立 review、用户 acceptance。

### T011：修复并发 max-turn continuation 幂等收敛

Status: Accepted for dependency progression
Priority: P0
Depends on: T005 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-04, AC-10
Parallel: No
Conflicts with: T010

目标:
修复两个并发 max-turn continuation 调度在同一源 Run 和 attempt 上不能稳定复用同一 Run 的问题。

允许修改范围:
- `server/src/services/heartbeat.ts`
- `server/src/__tests__/heartbeat-retry-scheduling.test.ts`
- `.verrail/targets/g2-7-production-closure/packets/T011.json`
- `.verrail/targets/g2-7-production-closure/runs/T011-A001/**`
- `.verrail/targets/g2-7-production-closure/tasks.md`
- `.verrail/targets/g2-7-production-closure/target.json`
- `.verrail/targets/g2-7-production-closure/timeline.jsonl`

验收标准:
- 并发调用都返回 scheduled 并引用同一 retry Run。
- 没有匹配 continuation 时，变化后的 issue execution lock 仍然 fail closed。
- 隔离回归、多次重复和 server typecheck 通过。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T011.json`

Evidence required:
- 并发失败复现、锁语义 review、重复回归结果。

### T012：补齐 Channel Connector webhook OpenAPI 契约

Status: Accepted for dependency progression
Priority: P0
Depends on: T009 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-02, AC-11
Parallel: No
Conflicts with: T010

目标:
将已挂载的公开 Channel Connector V1 callback 纳入 OpenAPI SSOT，恢复路由与契约的精确一致性。

允许修改范围:
- `server/src/routes/openapi.ts`
- `.verrail/targets/g2-7-production-closure/packets/T012.json`
- `.verrail/targets/g2-7-production-closure/runs/T012-A001/**`
- `.verrail/targets/g2-7-production-closure/tasks.md`
- `.verrail/targets/g2-7-production-closure/target.json`
- `.verrail/targets/g2-7-production-closure/timeline.jsonl`

验收标准:
- OpenAPI 精确覆盖新 webhook 路由及全部路径参数。
- 契约不错误声明 board/agent authentication；provider authentication 仍由 connector worker 校验。
- OpenAPI route suite、server typecheck 和 diff gate 通过。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T012.json`

Evidence required:
- 全量失败定位、OpenAPI 契约 diff、聚焦测试、typecheck 与 review。

### T013：隔离 OpenCode 环境诊断测试的主机配置

Status: Accepted for dependency progression
Priority: P0
Depends on: T012 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-11
Parallel: No
Conflicts with: T010

目标:
让 OpenCode model-unavailable 环境诊断测试使用自身临时 XDG 配置，而不是复制执行主机可能很大的真实配置目录。

允许修改范围:
- `server/src/__tests__/opencode-local-adapter-environment.test.ts`
- `.verrail/targets/g2-7-production-closure/packets/T013.json`
- `.verrail/targets/g2-7-production-closure/runs/T013-A001/**`
- `.verrail/targets/g2-7-production-closure/tasks.md`
- `.verrail/targets/g2-7-production-closure/target.json`
- `.verrail/targets/g2-7-production-closure/timeline.jsonl`

验收标准:
- 测试不读取或复制主机 `~/.config/opencode`。
- ProviderModelNotFoundError 仍被断言为 warn。
- 聚焦测试重复通过，server typecheck 与 diff gate 通过。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T013.json`

Evidence required:
- 超时复现、环境隔离 diff、重复测试与 review。

### T014：让受治理的 GitHub PR 携带完整、审批绑定的正文

Status: Accepted for dependency progression
Priority: P0
Depends on: T006, T007 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-07, AC-08, AC-11
Parallel: No
Conflicts with: T010

目标:
将完整 PR 正文纳入 ActionRequest 参数和批准哈希，同时只追加一个稳定 Provider marker。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T014.json`

Evidence required:
- 正文哈希绑定、兼容读取、Provider payload、聚焦测试与 review。

### T015：让工作台绑定真实活跃 DeploymentRevision

Status: Accepted for dependency progression
Priority: P0
Depends on: T008 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-03, AC-09
Parallel: No
Conflicts with: T010

目标:
从当前 Workspace 的活跃 Deployment 选择受版本治理的 DeploymentRevision，并用该标识创建 GraphRevision 和 Run。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T015.json`

Evidence required:
- 原失败复现、选择器单测、UI 类型检查、token gate、真实浏览器 GraphRevision 创建和激活事实。

### T016：将原生 RunAttempt 接入可信 Codex 执行器

Status: Accepted for dependency progression
Priority: P0
Depends on: T005, T015 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-03, AC-04, AC-10
Parallel: No
Conflicts with: T010

目标:
由 TypeScript 可信主机执行桥接器认领 Go Domain API 发出的原生执行租约，将固定版本的 RunAttempt 交给现有 Codex heartbeat 执行器，并把心跳、取消和终态通过 Domain API 回报。

允许修改范围:
- `server/src/services/verrail-run-executor.ts`
- `server/src/services/verrail-run-executor.test.ts`
- `server/src/services/heartbeat.ts`，仅用于保留原生 Target 任务正文。
- `server/src/services/index.ts`
- `server/src/index.ts`
- `docs/temporal-target-workflow.md`
- `.verrail/targets/g2-7-production-closure/**`

验收标准:
- 只认领配置执行主体的 offered/active/suspect 租约，并验证 Workspace、DeploymentRevision、AgentVersion、AgentDefinition、运行时适配器与活跃状态一致。
- 先以 fencing token 和递增 cursor 通过 Go Domain API 认领，再调用现有 heartbeat/Codex 执行器；不直接改写原生 Run、Attempt、Lease。
- 重启时按原生 RunAttempt 持久关联复用 heartbeat run，不重复执行。
- 活跃执行续租；成功、失败和取消均回报权威原生事件与可审查的非敏感执行事实。
- 原生 Target 的目标、约束和完成定义进入 Codex 提示，不依赖旧 Issue。

验证命令:
- `pnpm --filter @paperclipai/server exec vitest run src/services/verrail-run-executor.test.ts`
- 相关 heartbeat focused tests。
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm test:domain-api`
- `git diff --check`

TDD plan:
- RED: 覆盖认领、重启复用、续租、成功、失败、取消与身份/运行时不匹配。
- GREEN: 实现最小租约扫描、heartbeat 桥接和 Domain API 回报。
- REFACTOR: 收敛 cursor、相关性和调度生命周期，不改变 Go 权威边界。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T016.json`

Evidence required:
- RED/GREEN、状态映射、重启幂等、取消传播、focused tests、typecheck、文档和 review。

### T017：阻止未通过评估的 Deployment 被恢复

Status: Accepted for dependency progression
Priority: P0
Depends on: T016 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-03, AC-11
Parallel: No
Conflicts with: T010

目标:
让 `resume` 与 create、upgrade、rollback 使用同一 passing quality + passing safety 评估门禁，避免暂停的兼容 Deployment 绕过生产准入。

允许修改范围:
- `services/domain-api/internal/target/agent_lifecycle_store.go`
- `services/domain-api/internal/target/agent_lifecycle_test.go`
- `.verrail/targets/g2-7-production-closure/**`

验收标准:
- 当前 Revision 绑定的 EvaluationRun 非 passed/passed 时，resume 返回 `AGENT_EVALUATION_GATE_FAILED`。
- 失败 resume 不创建 Revision、不改变 Deployment 或当前 Revision 状态。
- 通过评估的暂停 Deployment 仍可 resume；create、upgrade、rollback 语义不变。

验证命令:
- `VERRAIL_TEST_DATABASE_URL=... go test ./internal/target -run TestResumeDeploymentEvaluationGateIntegration`
- `pnpm test:domain-api`
- `git diff --check`

TDD plan:
- RED: 创建 inconclusive/not_run Revision，证明 resume 错误通过。
- GREEN: 在 resume 事务内复用 `assertPassingEvaluation`。
- REFACTOR: 不增加新的准入定义，保持单一门禁函数。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T017.json`

Evidence required:
- RED/GREEN、拒绝码、无副作用断言、Go suite 与 review。

### T018：校验版本模型与提示词执行快照

Status: Accepted for dependency progression
Priority: P0
Depends on: T016, T017 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-03, AC-10
Parallel: No
Conflicts with: T010

目标:
在 HostTrusted 兼容执行桥接边界验证 AgentVersion 的 runtime、model 和 prompt 与实际 compatibility Agent 快照一致，拒绝只在数据库中绑定版本但实际执行可变配置的运行。

允许修改范围:
- `server/src/services/verrail-run-executor.ts`
- `server/src/services/verrail-run-executor.test.ts`
- `ui/src/pages/VerrailAgents.tsx`，仅修正 Codex runtime 默认标识。
- `ui/src/pages/VerrailAgents.test.tsx`
- `.verrail/targets/g2-7-production-closure/**`

验收标准:
- runtime adapter、显式 model 和 prompt/capabilities 任一不一致时，在启动 heartbeat 前 fail closed。
- 匹配的固定快照继续执行；未配置 model 不能冒充显式固定模型。
- 版本发布 UI 的 Codex runtime 默认值使用真实 adapter 标识 `codex_local`。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T018.json`

Evidence required:
- mismatch RED/GREEN、runner/UI focused tests、typecheck、token gate 与 review。

### T019：让 Codex ACP 使用受管运行时二进制

Status: Accepted for dependency progression
Priority: P0
Depends on: T018 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-03, AC-10, AC-11
Parallel: No
Conflicts with: T010

目标:
让本地主机上的 Codex ACP server 明确调用与 compatibility Agent 运行时配置一致且已经通过 PATH/命令门禁的 Codex 二进制，而不是隐式依赖 ACP npm 包内可能缺失的平台可选包。

允许修改范围:
- `packages/adapters/codex-local/src/server/acp.ts`
- `packages/adapters/codex-local/src/server/acp.test.ts`
- `.verrail/targets/g2-7-production-closure/**`

验收标准:
- 本地 ACP 启动环境通过 `CODEX_PATH` 绑定 `runtimeCommandSpec.command`，默认绑定 `codex`。
- Agent 显式配置的 `env.CODEX_PATH` 优先且不被覆盖。
- 远程执行不注入主机路径，继续遵守目标侧运行时安装与解析边界。
- 真实 MYW-1 重试不再出现 `Missing optional dependency @openai/codex-darwin-arm64`，并产生可审查的真实 Codex 输出。

验证命令:
- `pnpm --filter @paperclipai/adapter-codex-local exec vitest run src/server/acp.test.ts`
- `pnpm --filter @paperclipai/adapter-codex-local typecheck`
- 真实浏览器重试 MYW-1 并核验 heartbeat run。
- `git diff --check`

TDD plan:
- RED: 证明本地 ACP effective environment 未设置 `CODEX_PATH`，会落入损坏的包内 Codex shim。
- GREEN: 在 Codex ACP adapter 边界注入受管 runtime command。
- REFACTOR: 保持远程和显式 override 语义不变。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T019.json`

Evidence required:
- 原始真实失败、RED/GREEN、focused suite、typecheck、真实 MYW-1 成功运行与 review。

### T020：同步 GitHub PR 正文归一化路由测试契约

Status: Accepted for dependency progression
Priority: P0
Depends on: T014, T019 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-07, AC-11
Parallel: No
Conflicts with: T010

目标:
修正 Connector 路由测试的过时断言，明确验证省略 GitHub PR 正文的兼容请求会在共享 schema 边界归一化为 `body: ""` 后再交给 Domain API。

允许修改范围:
- `server/src/__tests__/connector-routes.test.ts`
- `.verrail/targets/g2-7-production-closure/**`

验收标准:
- HTTP 请求仍可省略 `params.body`，维持 T014 的调用方兼容承诺。
- Domain API mock 明确收到归一化后的 `params.body: ""`，测试不再把原始 wire payload 与内部规范化命令混为一谈。
- 不修改产品代码或放宽 validator。

验证命令:
- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/connector-routes.test.ts`
- `pnpm --filter @paperclipai/server typecheck`
- `git diff --check`

TDD plan:
- RED: 完整 Vitest 已证明旧断言期望缺少 `body`，而共享 schema 正确输出 `body: ""`。
- GREEN: 分离原始请求 fixture 与规范化 Domain API fixture，并更新代理断言。
- REFACTOR: 保持测试 helper 单一且命名清楚，不改生产行为。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T020.json`

Evidence required:
- 完整门禁原始失败、focused GREEN、server typecheck、diff gate 和 review。

### T021：为 Verrail 浏览器验收分配独占动态端口

Status: Accepted for dependency progression
Priority: P0
Depends on: T020 Accepted
Blocks: T010 resume
Story / Requirement: E005, AC-09, AC-11
Parallel: No
Conflicts with: T010

目标:
修复浏览器验收 runner 与 CLI 端口选择不一致的问题：没有显式覆盖时分配可用 loopback 端口，并把同一端口传给 Playwright 的健康检查、base URL 和被测服务器。

允许修改范围:
- `scripts/run-verrail-acceptance.mjs`
- `scripts/__tests__/run-verrail-acceptance.test.mjs`
- `.verrail/targets/g2-7-production-closure/**`

验收标准:
- 默认运行不依赖固定 `3203`，也不终止或复用占用该端口的其他服务。
- 动态选择的 IPv4 loopback 端口通过 `VERRAIL_ACCEPTANCE_PORT` 传给 Playwright child。
- 调用方显式设置 `VERRAIL_ACCEPTANCE_PORT` 时保持原值。
- 临时 `PAPERCLIP_HOME` 在成功和失败后继续清理。

验证命令:
- `node --test scripts/__tests__/run-verrail-acceptance.test.mjs`
- `pnpm test:e2e:verrail-acceptance`
- `git diff --check`

TDD plan:
- RED: 用 fake pnpm 证明 runner 当前没有为默认运行传播独占端口，并覆盖显式端口契约。
- GREEN: 在 runner 边界分配可用 loopback 端口并注入 child environment。
- REFACTOR: 保持端口选择和临时目录生命周期清楚，避免更改 Playwright 产品旅程。

Packet path:
- `.verrail/targets/g2-7-production-closure/packets/T021.json`

Evidence required:
- 原始 browser gate 超时、RED/GREEN runner tests、真实 browser acceptance、diff gate 和 review。

### T022: Isolate embedded Vite dependency caches

Status: Accepted for dependency progression (T022-A002, browser 6/6 and live Workbench verified)
Priority: P0
Depends on: T021 Accepted
Blocks: T010 resume
Requirements: AC-09, AC-11
Parallel: No
Packet: `.verrail/targets/g2-7-production-closure/packets/T022.json`

The live workbench must remain usable when an acceptance server starts in the same
checkout. Scope is the embedded Vite cache directory, its focused tests and the
development contract. No database or UI component changes are authorized.

### T023: Feishu Long-Connection Ingress

Status: Accepted for technical dependency progression; real private-chat ingress and reply verified (T023-A002)
Depends on: T022 Accepted
Blocks: T010 real Feishu acceptance
Requirements: AC-02, AC-09, AC-11
Parallel: No
Packet: `.verrail/targets/g2-7-production-closure/packets/T023.json`

Preserve the user-selected application's published long-connection configuration.
Use the official SDK inside the connector worker, pass only normalized events to
the configured-workspace host ingress, and retain explicit user mapping, draft
confirmation, idempotency and secret boundaries. No public callback exposure or
permission expansion is part of this task.

### T024: Resume Channel Draft in Web Chat

Status: Accepted for technical dependency progression (T024-A001)
Depends on: T023 Accepted
Blocks: T010 complete enterprise-channel creation acceptance
Requirements: AC-02, AC-09
Parallel: No
Packet: `.verrail/targets/g2-7-production-closure/packets/T024.json`

Expose existing conversation drafts and reuse their immutable source identity and
versioned update/confirmation endpoints. Preserve separate review and confirmation
steps; do not replace the real Feishu draft with a new Web-created draft.

### T025: Native Retry Executor Identity

Status: Focused tests passed; live retry recovery in progress
Depends on: T024 Accepted
Blocks: T010 native execution acceptance
Requirements: AC-03, AC-09, AC-10
Parallel: No
Packet: `.verrail/targets/g2-7-production-closure/packets/T025.json`

Use the registered `verrail-host-runner` identity for host-trusted UI retries.
Retain the incorrect attempt as failure evidence and rely on normal lease expiry,
fencing and retry rather than repairing database rows.

### T026: Governed Native Outbox Recovery

Status: Technical recovery verified; independent review pending
Depends on: T025 technical fix
Blocks: T010 native retry, cancellation and worker recovery proof
Requirements: AC-04, AC-09, AC-10
Parallel: No
Packet: `.verrail/targets/g2-7-production-closure/packets/T026.json`

Align cancellation event names and add scoped, audited dead-letter recovery with
ordered replay. Verify failed-workflow retry and stale cancellation/fencing before
replaying the real aggregate. Manual SQL repair and blanket dead-letter resets
do not satisfy this task.

Real recovery evidence: `runs/T026-A002/evidence.json`. The dead letter and its
three blocked successors are delivered; attempt 3 expired with audit, and one
explicit retry created attempt 4. The real executor claimed it and rejected the
pinned model mismatch before invoking Codex. Technical evaluation and deployment
configuration are delegated to Codex; final delivery decisions remain human.

## 当前技术执行

- T027：评测表单不预填通过结论或虚构测量值；空成本保持未知，显式零值保留。专项测试通过。
- T028：固定 AgentVersion 提示词进入原生执行任务，CLI 回退路径携带相同任务上下文。30 项回归通过。
- T029：DeploymentRevision 固定本地 cwd，校验可信唤醒、工作区、版本、租约和 fencing。40 项组合测试及追加 23 项绑定测试通过；server/UI 类型检查、UI 构建与令牌检查通过。
- T030：已有活动工作图时允许激活当前目标的非空草稿；真实缺陷 RED 后，34 项读模型与工作台回归通过。
- T010：Director v2 的 8 项真实模型治理冒烟评测通过，EvaluationRun 为 `b706d06e-5080-4c92-b0c9-c8b0441a53f9`。完整安全认证和最终交付验收不在该结论内。
- 原生 Run `51b1b034-477c-429d-9305-c2f17f0e736a` 已创建，工作图 r3 已激活。第二次尝试对应真实 Codex 心跳 `5b177f87-17e1-4abc-a65b-f7cfacfc82b8`，已观察到实际仓库执行；结果与产物仍待核查。

## 用户审核闸门

- Approval: Approved by the Outcome Owner on 2026-09-04
- 后续技术计划闸门已委托 Codex 根据依赖、packet、evidence 和 review 自行批准，不逐项打扰用户。
- 中间任务必须通过 spec compliance、engineering quality 和 QA；最终产品内真人决定、目标验收、
  merge、发布和 ship record 仍保持原有权限边界。
