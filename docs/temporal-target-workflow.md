# TargetWorkflow 与 RunWorkflow 耐久编排合同

版本：0.2

状态：`Confirmed`

最后更新：2026-09-04

## 1. 目的

`TargetWorkflow` 与 `RunWorkflow` 把已提交的 Target 和 Run 领域事件转换为可恢复、可查询的耐久编排历史。PostgreSQL 保存 Target、TargetRevision、Run、RunAttempt、ExecutionLease、RunEvent、AuditEvent 与 outbox 投递事实；Temporal 只保存编排状态，不成为业务事实源。

## 2. 版本化标识

| 合同 | 值 |
| --- | --- |
| Workflow Type | `verrail.target.workflow.v1` |
| Workflow ID | `verrail-target-v1:{workspaceId}:{targetId}` |
| Task Queue | `verrail-target-v1` |
| Signal | `verrail.target.event.v1` |
| Query | `verrail.target.state.v1` |
| Reconcile Activity | `verrail.target.reconcile-activity.v1` |
| 领域事件 | `verrail.target.created.v1`、`verrail.graph.activated.v1` |

| Run 合同 | 值 |
| --- | --- |
| Workflow Type | `verrail.run.workflow.v1` |
| Workflow ID | `verrail-run-v1:{workspaceId}:{runId}` |
| Task Queue | `verrail-target-v1` |
| Signal | `verrail.run.event.v1` |
| Query | `verrail.run.state.v1` |
| Ensure Attempt Activity | `verrail.run.ensure-attempt-activity.v1` |
| Request Cancellation Activity | `verrail.run.request-cancellation-activity.v1` |
| 领域事件 | `verrail.run.created.v1`、`verrail.run.attempt_changed.v1`、`verrail.run.cancellation_requested.v1` |

Workflow 与 Signal Payload 只包含 schema version、Workspace、Target、TargetRevision、outbox event ID、event type 和发生时间。禁止放入 Secret、Prompt、Artifact 正文、日志或大型业务快照。

Activity ID 使用稳定业务身份：Graph reconciliation 为 `reconcile:{graphRevisionId}:{cycle}`，RunAttempt 确保为 `ensure-attempt:{runId}:{attemptOrdinal}:{recoveryCycle}`，取消为 `request-cancel:{runId}`。Run child Workflow 始终使用 `verrail-run-v1:{workspaceId}:{runId}`。Activity 内部领域命令使用稳定幂等键，Temporal Activity Retry 不得产生重复 Run、RunAttempt、AuditEvent 或 outbox fact。

## 3. Transactional Outbox

Go Domain API 在创建 Target 的同一事务内写入 `verrail_outbox_events`。独立 Go orchestration worker 按以下状态推进投递：

```text
pending -> delivering -> delivered
              |
              +-> pending   (retryable failure)
              +-> failed    (unsupported contract or retry exhaustion)
```

Dispatcher 只领取已到 `available_at` 的 `pending` 事件或租约过期的 `delivering` 事件。领取使用 `FOR UPDATE SKIP LOCKED`、唯一 `claim_token` 和 `lease_expires_at`，同一 aggregate 的较新事件在较旧事件完成前保持阻塞。事务提交并释放行锁后才调用 Temporal。

成功投递通过同一 `claim_token` 写回 `workflow_id`、`workflow_run_id` 和 `published_at`。过期 Worker 的确认不匹配当前 token，返回 claim-lost 错误，不能覆盖新 Worker 的结果。

## 4. 投递与幂等

Dispatcher 使用 Temporal `SignalWithStart` 原子地启动或 Signal 稳定 Workflow ID，并把 outbox event ID 作为投递身份。投递语义是 at-least-once：Worker 在 Temporal 成功后、PostgreSQL 确认前失效会导致同一事件再次投递。

两个 Workflow 都保存有界的已处理 event ID。重复事件与聚合身份不一致的事件只增加忽略计数，不改变编排阶段。每个 Workflow Run 接受 256 个有效事件后执行 Continue-As-New；携带状态保持身份、计数、活动 Revision 或 Attempt 与有界去重集合。

## 5. 编排状态与主动行为

`verrail.target.created.v1` 把 Workflow 的内部 phase 从 `waiting_for_target_event` 推进到 `awaiting_graph`。`verrail.graph.activated.v1` 固定活动 TargetRevision 与 GraphRevision，并把 phase 推进到 `orchestrating`。这些 phase 只表示编排器已收到已提交领域事件，不是用户可见 Target 或 WorkNode 状态。UI、权限、TargetReadModel 和完成判断不得把 Temporal Query 当作业务事实。

GraphRevision 激活后，`TargetWorkflow` 通过 Reconcile Activity 请求 Graph Engine 读取活动 Revision、激活所有依赖已完成的 `pending` 节点，并返回可调度 AgentTask、等待中的 HumanTask/IntegrationTask/Gate 和活动 Run。Activity 只调用 Domain API Store 命令，不直接执行 workflow-side SQL。Graph Engine 是 WorkNode 状态的唯一写入者。

每个 ready AgentTask 通过版本固定的 DeploymentRevision 创建或返回幂等 Agent Run。`TargetWorkflow` 使用稳定 child Workflow ID 启动 `RunWorkflow`，并在领域 Signal 或 30 秒轮询 Timer 后再次 reconciliation。HumanTask、IntegrationTask 和 Gate 保持等待，直到对应领域结果命令提交事实；Temporal 不代替人类、Connector、Review 或 Acceptance 作决定。

GraphRevision 激活、Run 创建、RunAttempt 创建、ExecutionLease、事件游标、fencing 和取消由 Domain API 裁决。`RunWorkflow` 以 `awaiting_attempt`、`awaiting_executor`、`running`、`recovering`、`canceling`、`succeeded`、`failed` 和 `canceled` 表示编排阶段，不直接写业务状态。它通过 Ensure Attempt Activity 创建第一个 Attempt；租约宽限期结束或可重试失败后，以递增 retry identity 请求恢复。服务 Principal 在租约仍有效或被心跳延长时返回当前 Attempt；租约真正过期后才创建更高 fencing token 的新 Attempt。旧 Attempt Signal 和事件不能覆盖当前 Attempt。

Workflow 收到已提交的取消请求后进入 `canceling`，等待 Runner 的 `cancel_acknowledged` 与 `terminated` 事实。Temporal Workflow 自身被取消时，在 disconnected context 中幂等请求领域取消；最终 `canceled` 仍以 PostgreSQL 中已提交的终止事实为准。

执行边界采用 `HostTrusted` 本地 service Principal。Go Worker 创建版本绑定 Attempt 和 ExecutionLease；TypeScript `verrail-host-runner` 扫描自己拥有的 `offered`、`active` 或 `suspect` 租约，验证同一 Workspace 中的活跃 DeploymentRevision、AgentVersion、AgentDefinition、兼容执行 Agent 与 runtime adapter 一致后，才复用现有 heartbeat/Codex 执行器。

Runner 必须先通过 Domain API 提交 `claimed`，再启动 heartbeat run 和提交 `started`。原生 RunAttempt ID 写入 heartbeat `context_snapshot`，重启时以该持久关联复用已有执行，不能重复启动 Codex。Target 的 goal、constraints、acceptance criteria、WorkNode 和 completion definition 作为原生任务正文进入执行上下文，不要求创建兼容 Issue。

活跃 heartbeat run 由 Runner 定期提交 `heartbeat` 延长租约。heartbeat run 终止后，Runner 只把 heartbeat run ID、环境/日志引用、日志哈希、用量、退出状态和错误码等非敏感事实提交为 `succeeded` 或 `failed`。领域取消先传播到 heartbeat run，再依次提交 `cancel_acknowledged` 和 `terminated`。Runner 不直接更新原生 Run、Attempt、Lease 或 WorkNode 表；所有状态转换、游标和 fencing 仍由 Go Domain API 裁决。

原生执行正文包含固定 AgentVersion 的提示词、目标定义、节点完成条件与权限边界。Codex ACP 与 CLI 回退均保留该正文；执行器成功不替代真人 Review、ActionApproval 或 Acceptance，也不授权创建替代 Issue。

本地原生执行要求 DeploymentRevision 的 `runtimeConfig.cwd` 固定绝对工作目录。智能体部署界面提供该字段；目录必须存在，符号链接解析后的实际目录与原始配置共同进入带内容哈希的环境快照。Heartbeat 只在数据库中的 RunAttempt、Workspace、兼容 Agent 和 `verrail-host-runner` 系统唤醒回执一致且租约有效时读取该配置，不接受消息载荷提供的目录覆盖。远程环境拒绝使用该本地配置。执行结果关联同一环境快照，历史 DeploymentRevision 与 Run 不原地修改。

该边界提供租约心跳、过期恢复、单调事件游标、旧 fencing token 拒绝和可观察取消。远程 Execution Gateway、Runner Fleet 和强隔离 Runtime 不在本合同的当前实现范围。

## 6. 失败与恢复

- Temporal 不可用时，已提交 Target 不回滚；事件按指数退避返回 `pending`。
- Worker 失效后，`delivering` 事件在 lease 到期后可被重新领取。
- Domain Activity 使用 30 秒 Start-To-Close、2 分钟 Schedule-To-Close 和最多 5 次指数退避重试；同一 Activity 的重试保持相同 Activity ID 与领域幂等键。
- RunAttempt 的恢复 Timer 以数据库返回的 `grace_expires_at` 为准；心跳延长租约后，Ensure Activity 返回当前 Attempt 和新期限。
- 失败 Attempt 在最大尝试数内进入 `recovering`；尝试耗尽返回不可重试的 `RUN_ATTEMPTS_EXHAUSTED` Workflow 错误。
- Workflow Run 接受 256 个有效事件后执行 Continue-As-New，并携带活动 Revision、Attempt、retry count、活动 Run、等待节点和有界 event ID 集合。
- `active-target-orchestration` 与 `active-run-orchestration` version gate 保持既有 v1 历史使用 signal-only 路径；Continue-As-New 形成的新 Run 再采用主动 Activity 路径。
- 默认最多尝试 8 次，退避从 1 秒增长并封顶 1 分钟。
- 不支持的 event type、无效 payload 或尝试耗尽进入 `failed` 并保留 `last_error`。
- `failed` 不自动回到队列。Target Workbench 的 Runs 页展示失败事件，Workspace 成员通过“重试事件投递”显式请求重新入队。命令绑定 Run、event ID、观察到的 attempt count 和幂等键；只允许重新入队该 aggregate 最早的未完成事件，保留原 payload、event ID 与累计投递次数，并原子记录命令回执和 `run.outbox_retry_requested` 审计事件。它不创建 RunAttempt、不修改租约，也不把事件标记为已投递。
- 事件重新入队不等于执行恢复成功。Dispatcher 从已提交的用户命令回执取得恢复授权，不信任 event payload 中的授权标志。普通投递采用 `REJECT_DUPLICATE`；显式恢复先检查 Workflow 状态，仅为失败历史采用 `ALLOW_DUPLICATE_FAILED_ONLY`。运行中的 Workflow 接收 Signal，已完成、已取消和已终止的历史拒绝重开。
- 重开的 RunWorkflow 使用独立 recovery 输入路径，通过 `verrail.run.observe-recovery-activity.v1` 读取 PostgreSQL 权威状态。Activity 在 Workspace 权限检查及 Run/Attempt/Lease 事务锁内，只将当前已过宽限期的租约收敛为过期，记录失败与 `run.lease_expired` 审计；不创建 Attempt，不伪造 executor RunEvent。后续执行仍要求正常显式重试命令，预算与 fencing 不变。
- 恢复模式把历史 Signal 作为唤醒通知，不允许其覆盖当前 Attempt 或取消较新的重试。它等待当前租约期限，跨 Continue-As-New 保留恢复模式及事件去重信息，并在成功或取消的 Run 的 outbox 排空后结束。管理性取消恢复观察器不等于取消业务 Run。设计约束见 [ADR 0006](adrs/0006-explicit-failed-run-recovery.md)。

本合同不宣称 PostgreSQL 与 Temporal 之间存在 exactly-once。

## 7. 运行单元

`services/domain-api/cmd/domain-api` 拥有 Target 写命令；`services/domain-api/cmd/orchestration-worker` 同时运行 Temporal Worker 和 outbox Dispatcher。TypeScript server 中的 `verrail-host-runner` 消费 HostTrusted 租约并调用已配置的本地 adapter。三者共享 PostgreSQL 领域事实，通过 Domain API 和 outbox/Temporal 合同协作，不依赖进程内状态作为权威事实。

本地 Temporal 使用 `docker/docker-compose.temporal.yml` 中固定版本的 development server。该服务只用于开发和验证，不代表生产级高可用拓扑。

远程 Temporal 可以配置 API key 与 TLS server name。配置 `TEMPORAL_API_KEY` 时 Worker 强制启用 TLS，避免 credential 通过明文连接发送。
