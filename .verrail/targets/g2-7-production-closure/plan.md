# G2.7 技术计划

Version: v1.0
Status: Confirmed by the Outcome Owner on 2026-09-04
Source spec: `.verrail/targets/g2-7-production-closure/spec.md` (Confirmed)
Base commit: `b46307dbd05a912c38a32395b88662952286fd58`
Last updated: 2026-09-04

## 计划目标

以当前 TypeScript 兼容基座、Go Domain API、Go Temporal Worker 和 React UI 为基础，
按可独立验证的纵向切片关闭 G2。计划不追求一次性重写，而是让真实的
Target -> Run -> Artifact -> Evidence -> Submission -> Review -> Acceptance -> GitHub PR
主路径先具备正确的领域事实、权限、恢复和产品操作面。

## 已批准产品决策

1. GitHub 短期凭证由 TypeScript facade 解析，通过已认证且不持久化的内部请求临时传给
   Go；凭证不得进入日志、回执、数据库或 Temporal History。
2. 首个企业通道为飞书，只实现一个共享 Channel Connector 合同上的飞书纵向切片。
3. 一个真人 Outcome Owner 可以完成 Review、Action Approval 和 Acceptance，但三个动作
   必须是独立命令和审计事实；Submission 与 ActionRequest 由授权 Agent 或 Service 发起。

## Constitution Check

- `docs/constitution.md`：满足人类意图优先、证据优先、权限不可自授、可逆交付要求。
- `docs/operational-ontology.md`：保持 Workspace 边界、版本绑定、Graph Engine 写入权、
  五类授权分离、fencing、幂等和 UnknownEffect 先核验要求。
- `docs/architecture.md`：PostgreSQL 是业务事实源；Temporal 只调度领域命令；每个聚合只有
  一个写入 Owner；采用 expand/contract 和 Strangler 路由。
- 违反项：无。

## 当前基线

- Go Domain API 已拥有原生 Target、Graph、Run、Agent lifecycle、Assurance、Adjudication
  和 GitHub Connector 命令的主要写入路径。
- TargetWorkflow 与 RunWorkflow 已有 Signal、查询、去重和 Continue-As-New 基线，但没有
  完整 Activity、Child Workflow、Timer、Gate 和依赖节点推进。
- Submission 与 ActionRequest 当前由人类命令创建，存储层把发起类型固定为 `user`，导致
  单真人环境无法同时满足独立评审和批准。
- GitHub 真实客户端存在，但没有从 Node Secret Service 到 Go 的短期凭证解析路径，也没有
  UnknownEffect 对账。
- ProviderConversationBinding 与 TargetCreationDraft 已存在；飞书 Channel Connector 尚未
  实现。
- Workbench 可读取大部分 G2 事实，但缺少完整写操作和原生 Attention/Outcome 收敛。

## 技术决策

### PD-001：按纵向切片关闭，不先做 G3 重构

Decision:
先建立事实基线，再依次关闭权限来源、工作结果合同、主动编排、GitHub Effect、原生投影、
飞书入口和 UI，最后进行一次真实验收演练。

Rationale:
当前风险来自闭环之间的断点，而不是单个模块缺少更多抽象。先做广泛 Go 化会扩大迁移面，
却不能证明产品闭环。

Alternative rejected:
一次性重写控制平面。它会同时改变数据、权限、编排、执行和 UI，无法保持一个写入 Owner，
也难以逐步回滚。

### PD-002：Agent/Service 发起候选，人类作出治理决定

Decision:
Graph/Workflow 通过受认证的 service principal 创建 Submission 和 ActionRequest；人类命令
只负责 DeliveryReview、ActionApproval 和 Acceptance。所有 principal 都由调用边界注入，
请求体不能自报身份。

Rationale:
这既允许单真人工作区完成闭环，也保持“提出候选”与“批准候选”分离。

Security controls:
- 仅内部 Worker credential 可使用 service principal 命令。
- Board 路由不能通过请求字段伪装 agent/service。
- command receipt、audit event 和事实表保存实际 principal 类型与 ID。

### PD-003：先补齐结果事实，再增强编排

Decision:
通过前向迁移增加 IntegrationAttempt、HumanWorkResult，以及 IntegrationRun 所需的
GraphRevision、ConnectorVersion、Connection、Commit、Criterion、Environment 和 Provider
Receipt 绑定。现有事实不回填成虚构的新事实；旧行使用明确的 compatibility/null 语义。

Rationale:
Temporal 只有在命令目标和完成语义稳定后才能可靠调度，否则 Workflow 会固化不完整合同。

### PD-004：Temporal 负责协调，Graph Engine 负责裁决

Decision:
TargetWorkflow 读取可执行工作、调用幂等 Activity 发送领域命令，并启动版本固定的 child
RunWorkflow。节点 ready/completed/blocked/canceled、Gate 结果和 Target 状态仍由 Go Domain
API 在事务中裁决。

Required mechanics:
- deterministic workflow code 和版本标记；
- Activity retry policy 与稳定 idempotency key；
- Timer 驱动超时、租约和人工 Gate 等待；
- cancellation propagation；
- child workflow ID 固定到 Run ID；
- bounded history 与 Continue-As-New carried state；
- dependency-ready 激活和重复 Signal 去重。

### PD-005：短期凭证不进入持久命令

Decision:
TypeScript facade 在执行 Effect 的最后时刻，从现有 Secret Service 解析已绑定 GitHub
credential，构造只存在于内存中的内部请求。Go handler 将 credential 注入单次 GitHub client，
但不把它加入领域 input、receipt、audit payload 或 workflow payload。

Controls:
- 请求和错误日志统一脱敏；
- 禁止 body/header dump；
- 失败测试使用 sentinel credential 并扫描所有持久事实和日志；
- credential 生命周期不跨重试，重试时重新解析。

### PD-006：外部 Effect 使用显式状态机和核验后重试

Decision:
ActionRequest 增加 executing/unknown_effect/executed/failed 等受约束状态，并保存不含 Secret
的稳定 provider idempotency marker。超时或连接中断后先按 marker 查询 GitHub；找到对象则形成
EffectReceipt，确认不存在才允许重试，无法判断则保持 UnknownEffect 并进入 Attention。

Alternative rejected:
在数据库事务中直接调用 GitHub 后盲目重放。Provider 成功而事务回滚时会产生重复 PR。

### PD-007：飞书作为 Plugin Connector，不进入 Conversation 领域内核

Decision:
在 Plugin SDK 上增加版本化 Channel Connector 合同，由飞书插件负责 webhook 验签、事件去重、
外部会话身份和回复；Host Service 负责将规范化消息映射到 Conversation、
ProviderConversationBinding 和显式 TargetCreationDraft 命令。

Controls:
- 飞书签名/加密校验失败默认拒绝；
- provider event ID 唯一去重；
- workspace/connection/external conversation 三重绑定；
- 普通消息只追加 ConversationMessage；
- 只有明确创建意图才进入 Draft，最终确认必须由已授权真人完成。

### PD-008：UI 只调用原生命令和读模型

Decision:
Workbench 提供 Run、Submission、Review、Acceptance、Action Approval/Execution 和恢复控制；
Home Attention 与 Outcome 使用原生可重建投影。UI 不拼装权威状态，也不通过旧 Issue/Heartbeat
语义伪装 Target 进度。

## 交付顺序

### Gate A：事实基线

1. T001 建立 G1/G2 证据与领域不变量差距矩阵。
2. T002 修复被证据支持的交付记录不一致，并稳定全量测试基线。

Exit:
所有后续任务都能引用一份无虚假关闭项的基线；当前 HEAD 的全量验证结果可重复。

### Gate B：领域合同

3. T003 修复 Submission/ActionRequest 发起身份和 Target 生命周期权限。
4. T004 增加 IntegrationAttempt、HumanWorkResult 和完整版本绑定。

Exit:
每类节点有独立完成事实，单真人工作区不需要伪造第二个人类身份。

### Gate C：编排与外部 Effect

5. T005 将 TargetWorkflow/RunWorkflow 升级为主动、可恢复的 Graph 协调器。
6. T006 完成 GitHub 临时凭证、Effect 状态机和 UnknownEffect 对账。
7. T007 完成 Target 状态、Outcome、Timeline、Attention 和命令读写合同。

Exit:
控制平面重启、Worker 重启和 Provider 不确定结果都能从持久事实安全收敛。

### Gate D：用户入口与操作面

8. T009 实现飞书 Channel Connector 纵向切片。
9. T008 完成 Web Chat、Workbench、Attention 和 GitHub 操作界面。

Exit:
用户不需要直接调用 API 或修改数据库即可创建并治理完整交付。

### Gate E：生产闭环验收

10. T010 在真实 GitHub 仓库和飞书环境执行正常、拒绝、失效、重试与故障恢复演练，完成独立
    review，并交给 Outcome Owner 验收。

Exit:
只有全部证据存在、Target 可从 PostgreSQL 重建为 `accepted` 时，G2.7 才能进入
Needs_Review；只有用户明确接受后才能进入 Accepted。

## 数据与迁移策略

- 所有 schema 变更使用前向、可重跑、可对账的 expand migration。
- 先增加 nullable 或兼容字段和新表，再切换写入 Owner；本目标不执行破坏性 DROP。
- 新表必须有 Workspace 复合外键、唯一性/状态 CHECK、幂等键、必要索引和追加事实语义。
- migration 必须通过生成器无漂移、fresh PostgreSQL、已有 G1/G2 数据升级和失败恢复验证。
- read model 切换使用 Feature Flag 或成对版本；出现不一致时停止新命令并回退应用，不删除事实。

## 验证策略

每个行为任务默认执行 RED -> GREEN -> REFACTOR，并先跑最小测试。阶段门禁逐步扩大：

1. 目标 Go package、shared validator、server route/service 或 UI component 测试；
2. `pnpm test:domain-api`；
3. `pnpm --filter @paperclipai/db check:migrations`；
4. `pnpm -r typecheck`；
5. `pnpm check:token-gates`；
6. `pnpm test:run`；
7. `pnpm build`；
8. `pnpm test:e2e:verrail-acceptance`；
9. Temporal replay、Worker/Runner/Provider fault matrix 和联合恢复演练；
10. 真实飞书与 GitHub 浏览器验收。

全量测试中的波动必须被归因并可重复；单独复跑通过不能自动把全量失败判为绿色。

## 发布与回滚

- 使用 `codex/g2-7-production-closure` 隔离分支；一次只执行一个 Ready task。
- 每个任务独立 evidence 和 review，禁止把最后一次全量测试反推为所有任务都通过。
- 新命令和投影先关闭默认入口，通过影子读取/契约测试后逐 Workspace 开启。
- GitHub Effect 在凭证或对账失败时 fail closed；飞书 webhook 在验签、绑定或去重失败时拒绝并审计。
- 回滚只回退应用路由和 Worker 版本，保留新事实与迁移；不得用 destructive down migration 清理。

## 主要风险

1. **Secret 泄漏。** 通过短生命周期、内存传递、日志脱敏和持久层 sentinel 扫描缓解。
2. **重复 GitHub PR。** 通过稳定 marker、UnknownEffect 和 lookup-before-retry 缓解。
3. **Workflow 非确定性。** 通过版本标记、replay fixtures、Activity 隔离和 Continue-As-New 测试缓解。
4. **权限伪造。** 通过边缘绑定 principal、内部 service credential 和请求体不接受身份字段缓解。
5. **飞书 webhook 重放或串 Workspace。** 通过验签、event ID 去重和三重绑定缓解。
6. **兼容路径回归。** 通过一个写入 Owner、影子读取、对账指标和成对版本回退缓解。
7. **目标过宽。** 通过十个顺序任务、逐任务 allowed files 和阶段门禁控制。

## 用户审核闸门

- Approval: Approved by the Outcome Owner on 2026-09-04
- Outcome Owner 已授权 Codex 在证据和任务依赖满足后自行批准后续技术计划并连续推进，
  不需要逐任务请求批准。
- 该授权不允许 Codex 冒充真人作出产品内的 Review、Action Approval、Acceptance，也不授权
  merge、发布或 ship record；最终目标完成仍需向 Outcome Owner 报告并取得真人验收。
