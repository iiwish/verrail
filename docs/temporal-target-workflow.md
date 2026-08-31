# TargetWorkflow 耐久编排合同

版本：0.1

状态：`Confirmed`

最后更新：2026-08-27

## 1. 目的

`TargetWorkflow` 把已提交的 Target 领域事件转换为可恢复、可查询的耐久编排历史。PostgreSQL 保存 Target、TargetRevision、AuditEvent 与 outbox 投递事实；Temporal 只保存编排状态，不成为 Target、Graph、Review 或 Acceptance 的事实源。

## 2. 版本化标识

| 合同 | 值 |
| --- | --- |
| Workflow Type | `verrail.target.workflow.v1` |
| Workflow ID | `verrail-target-v1:{workspaceId}:{targetId}` |
| Task Queue | `verrail-target-v1` |
| Signal | `verrail.target.event.v1` |
| Query | `verrail.target.state.v1` |
| 首个事件 | `verrail.target.created.v1` |

Workflow 与 Signal Payload 只包含 schema version、Workspace、Target、TargetRevision、outbox event ID、event type 和发生时间。禁止放入 Secret、Prompt、Artifact 正文、日志或大型业务快照。

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

`TargetWorkflow` 保存有界的已处理 event ID，重复事件与 Workspace/Target 不一致的事件只增加忽略计数，不改变活动 TargetRevision 或编排阶段。每个 Workflow Run 接受 256 个有效事件后执行 Continue-As-New；携带的状态保持身份、计数、活动 Revision 与有界去重集合。

## 5. 当前编排状态

首个事件把 Workflow 的内部 phase 从 `waiting_for_target_event` 推进到 `awaiting_graph`。该 phase 只表示编排器已收到 Target 事件，不是用户可见 Target 状态，也不激活 Graph。UI、权限、TargetReadModel 和完成判断不得把 Temporal Query 当作业务事实。

Graph Engine、RunWorkflow、Activity、执行租约、Submission、Evidence、Review 与 Acceptance 属于后续垂直切片。

## 6. 失败与恢复

- Temporal 不可用时，已提交 Target 不回滚；事件按指数退避返回 `pending`。
- Worker 失效后，`delivering` 事件在 lease 到期后可被重新领取。
- 默认最多尝试 8 次，退避从 1 秒增长并封顶 1 分钟。
- 不支持的 event type、无效 payload 或尝试耗尽进入 `failed` 并保留 `last_error`。
- `failed` 不自动回到队列；后续运维修复必须保留原 event ID 并留下审计记录。

本合同不宣称 PostgreSQL 与 Temporal 之间存在 exactly-once。

## 7. 运行单元

`services/domain-api/cmd/domain-api` 拥有 Target 写命令；`services/domain-api/cmd/orchestration-worker` 同时运行 Temporal Worker 和 outbox Dispatcher。二者共享 Go module 与合同，但作为独立进程部署，互不以进程内调用耦合。

本地 Temporal 使用 `docker/docker-compose.temporal.yml` 中固定版本的 development server。该服务只用于开发和验证，不代表生产级高可用拓扑。

远程 Temporal 可以配置 API key 与 TLS server name。配置 `TEMPORAL_API_KEY` 时 Worker 强制启用 TLS，避免 credential 通过明文连接发送。
