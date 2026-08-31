# Verrail 架构契约

版本：0.3

状态：`Confirmed`

最后更新：2026-08-28

## 1. 架构目标

Verrail 采用 PostgreSQL 业务事实库、Temporal 耐久编排、对象存储和独立执行平面。当前兼容 API 与大量继承能力运行在 TypeScript Server；新领域内核的 Go 目标边界由 ADR-0004 定义。架构优先保证：

1. 交付事实可恢复、可审计、可验收；
2. Agent Harness、Sandbox Backend 和 Provider 可替换；
3. 开源自托管、托管 Cloud 和客户 VPC 执行使用同一领域合同；
4. 企业代码、凭证和网络边界可以留在客户环境；
5. 进程、API、Temporal Worker、Runner 或 Harness 失效后，长流程仍能恢复；
6. 现有 Paperclip 基座可以渐进重构，不以大爆炸重写阻塞产品验证；
7. Go 服务通过领域切片和语言中立协议接管责任，不复制业务模型或长期双写事实库。

## 2. 系统上下文

```text
Human / API / Provider Event
             |
             v
+------------------------------------------------------+
| Verrail Control Plane                                |
| Auth | Project/Target | Graph | Agent Lifecycle      |
| Artifact/Evidence | Policy | Audit | Scheduler       |
+--------------------------+---------------------------+
                           |
                    Temporal Service
                           |
                    Temporal Worker
                           |
                    Execution Gateway
                           |
          +----------------+----------------+
          |                                 |
  Managed RuntimePool                Private RuntimePool
  CubeSandbox / container            Customer VPC Runner
          |                                 |
  AgentRuntimeAdapter                AgentRuntimeAdapter
          |                                 |
      Codex / ...                        Codex / ...
```

PostgreSQL 中的控制平面领域记录拥有业务事实。Temporal 拥有耐久编排历史；Execution Gateway、Runner、Sandbox 和 Adapter 只执行带租约的命令并回传候选事件、结果和证据。

## 3. 当前工程基座

| 层 | 基座 | 当前责任 |
| --- | --- | --- |
| Web | React + Vite + TanStack Query | 操作台、设置、运行与审计界面 |
| Server | Node.js + TypeScript + Express | REST API、领域服务、Scheduler、Adapter 调用 |
| Domain API | Go + pgx + net/http | 原生 Target/TargetRevision 创建、命令幂等、AuditEvent 与 transactional outbox；当前由 TypeScript 边缘代理 |
| Database | PostgreSQL + Drizzle | 权威关系事实、迁移、事务与查询 |
| Durable Orchestration | Go + Temporal SDK | 已接入 Target outbox Dispatcher 与最小 TargetWorkflow；Graph/Run 编排属于后续切片 |
| Object Storage | Local/S3-compatible | Artifact、附件、日志和大对象 |
| Adapters | TypeScript packages | Codex、Claude、Cursor、Process、HTTP 等 Harness 接入 |
| Plugins | Plugin SDK | Provider、Sandbox、运行时服务和扩展能力 |
| CLI | TypeScript CLI | 安装、配置、诊断和控制平面操作 |

仓库内部仍有 `paperclipai` 包名、环境变量和领域命名。它们是兼容技术标识，按模块逐步迁移，不定义 Verrail 的产品语义。

### 当前兼容流程引擎

继承实现使用 PostgreSQL 行状态和 Node.js 服务代码共同推进流程：

- `agent_wakeup_requests` 与 `heartbeat_runs` 保存排队、认领、运行、计划重试和结果；
- `heartbeatService` 负责唤醒合并、并发认领、Adapter 调用、Run 日志、成本、Workspace、Secret、重试和终态处理；
- Server 启动时执行 orphan reaper、queued run resume、scheduled retry promotion、stranded issue reconciliation 和 stale lock sweep；
- 单个进程中的周期调度器使用 `setInterval` 扫描 Heartbeat、Routine、Monitor、Decision expiry、Recovery、Watchdog 和资源清理；
- Pipeline/Case 使用 PostgreSQL 事务、版本字段、租约和显式 transition 服务推进；
- Recovery Service 通过周期扫描识别 lost process、silent run、stranded issue、missing disposition 和失效租约，并创建重试或人工 Attention。

该实现具备真实的持久化、幂等和恢复保护，但调度、业务裁决、执行适配和补偿逻辑高度集中。新的 Verrail Target/Run 主流程不得继续复制这套 Timer 与 Sweeper 模式；存量路径在 Temporal 纵向切片通过验证后逐步只读化和退役。

## 4. 控制平面模块

### Identity and Tenant

负责 Workspace、Human、Group、ServiceAccount、RoleBinding、SSO/SCIM 边界和会话。所有数据访问先确定 Workspace，再校验 ResourceScope。

### Delivery Domain

负责 Project、Target、TargetRevision、StageProgress、HumanWorkResult、Outcome、AttentionItem 和 Timeline。这里定义用户可见的交付状态，不直接运行 Agent。

### Graph Engine

负责 GraphProposal 校验、GraphRevision、TaskNode/GateNode、节点激活、角色解析、依赖、强制 Gate 和重规划。Director 是计划提议者，Graph Engine 是唯一业务状态裁决者。

### Durable Orchestration

负责 TargetWorkflow、RunWorkflow、Child Workflow、Signal/Update、Timer、Retry、取消、Continue-As-New 和 Workflow Versioning。Temporal Worker 只编排领域命令和 Activity，不直接拥有 Target、Graph、Run、IntegrationRun、HumanWorkResult、Evidence、Review 或 Acceptance。Workflow ID、Task Queue、Search Attribute 和 Payload Codec 必须 Workspace-scoped 且版本化。

### Agent Lifecycle

负责 AgentDefinition、AgentVersion、Deployment、EvaluationRun、ImprovementProposal 和版本发布/回滚。Harness 私有配置通过 Adapter Manifest 固定，但不成为身份或权限事实。

### Artifact and Evidence

负责 AcceptanceCriterion、Claim、ArtifactContract、ArtifactRevision、内容 Hash、Materialization、IntegrationRun/IntegrationAttempt、Provider Receipt、Evidence、VerificationResult、Submission、DeliveryReview、ReviewComment 和 Acceptance。大对象写入 Object Store，关系、Hash 和生命周期写入 PostgreSQL。

### Capability Gateway

负责 Capability、Grant、Policy、Action、Approval、CredentialLease、Provider Effect 幂等与未知结果核验。所有外部写操作和敏感平台自操作经过此边界。

### Runtime Control

负责 RuntimePool、Runner、能力与容量、ExecutionLease、SandboxLease、WorkspaceVolume 和 EnvironmentManifest。它通过 Execution Gateway 发命令，不直连 Harness 或客户数据库。

### Audit and Observability

负责不可变 AuditEvent、领域事件、Run Event、Trace 关联、指标和安全事件。产品 Timeline 是领域投影，不等同于原始日志。

## 5. 数据与一致性

### PostgreSQL

PostgreSQL 是唯一业务事实库。TargetRevision、Graph 状态、Run/RunAttempt、IntegrationRun/IntegrationAttempt、HumanWorkResult、租约、授权、Artifact 元数据、Claim、Evidence、VerificationResult、Submission、Review、Acceptance 和 AuditEvent 必须在事务边界内保持一致。

领域命令使用 Transactional Outbox 发布后续工作。Outbox Dispatcher 使用稳定 Workflow ID 启动或 Signal Temporal；Temporal Activity 使用稳定命令 ID 调用领域服务。两个方向都必须容忍重复投递，不宣称跨 PostgreSQL 与 Temporal 的 exactly-once。长任务不依赖单个 API 或 Worker 进程的内存状态。

Temporal Event History 是编排恢复记录，不是业务查询模型。UI、权限判断、Graph 裁决、Submission、Review 和 Acceptance 从 PostgreSQL 读取；Temporal Search Attributes 只用于运维定位和队列治理。

### Object Storage

Artifact 内容、附件、大日志和 Checkpoint 存入 Local 或 S3-compatible Storage。数据库保存租户、类型、大小、Hash、加密、保留策略和对象键。对象写入采用暂存、校验、提交元数据和异步回收流程。

### Search and Analytics

MVP 使用 PostgreSQL 投影和索引。搜索引擎、数据仓库或流系统只有在真实规模证明后引入，不能形成第二套业务写模型。

## 6. 执行链路

```text
Domain Command + Outbox
  -> Temporal TargetWorkflow
  -> Graph Engine activation decision
  -> Temporal RunWorkflow
  -> Runtime Scheduling Activity
  -> ExecutionLease + fencing token
  -> Execution Gateway
  -> Runner
  -> SandboxDriver / WorkspaceManager
  -> AgentRuntimeAdapter
  -> Harness
  -> normalized events / result / artifacts
  -> validation
  -> idempotent domain Activity
  -> Run/Artifact/Evidence state + AuditEvent
  -> Workflow Signal / completion
```

Agent 执行命令和事件携带 Workspace、TargetRevision、GraphRevision、WorkNode、Run、RunAttempt、Lease、协议版本、Workflow ID 和 Correlation ID。Integration 事件携带 IntegrationRun、IntegrationAttempt、Connector Version、Connection、Provider Ref 和幂等键；HumanWorkResult 携带 Principal 与输入版本。Runner 只能提交租约允许的结果。Temporal Retry 不替代 Effect 幂等、ExecutionLease 或 fencing。

详细合同见 [`execution-runtime.md`](./execution-runtime.md)。

## 7. Cloud 与企业拓扑

```text
Verrail Cloud Plane
  Account | Billing | SSO | Fleet | Region | Quota
                         |
                  Tenant Control Cell
       Domain API + PostgreSQL + Object Storage
                         |
              Temporal Namespace + Worker
                         |
                  Execution Gateway
             +-----------+-----------+
             |                       |
   Managed CubeSandbox       Customer VPC Runner
                                     |
                             Private Sandbox/Host
```

### Open-source self-hosted

单机或小团队使用 Domain API、PostgreSQL、对象存储、Temporal 开发/自托管服务和一个或多个 Worker/Runner。`pnpm dev:verrail` 是当前完整本地集成入口，以一个共享 PostgreSQL 和 Task Queue 启动 TypeScript 兼容边界、Go Domain API、Temporal 开发服务与 Go Worker；聚焦组件开发仍可分别启动。即使组件同机，也使用不同身份和协议边界。生产级自托管 Temporal 的支持等级必须明确，不能把开发服务器包装成高可用承诺。

### Managed Cloud

Cloud Plane 管理账户、计费、配额、区域与租户单元生命周期。Tenant Control Cell 承担租户业务事实并绑定 Temporal Namespace。首发可以共享基础设施，但逻辑合同必须允许高价值或受监管租户独立 Cell；Temporal Payload 必须加密并遵守数据驻留策略。

### Private execution

客户 VPC Runner 只需建立到 Gateway 的认证出站连接。控制平面不主动进入客户网络。DataEgressPolicy 决定 Prompt、日志、Artifact、源码和 Secret 哪些可以离开客户环境。

## 8. 插件与 Adapter 边界

- `AgentRuntimeAdapter` 负责 Harness 探测、启动、恢复、事件映射、取消和结果采集；
- `Connector` 负责外部 Provider 身份、事件、查询、Materialization 和 Action；
- `SandboxDriver` 负责隔离实例生命周期、文件、网络、资源、Checkpoint 和销毁；
- `SecretProvider` 负责引用、租约和审计，不向 Agent 返回长期凭证；
- Plugin 不得直连控制平面数据库、直接推进 Graph 或自行决定 Approval/Acceptance；
- 所有扩展合同必须版本化并有 Contract Test。

## 9. 渐进式领域迁移

领域重构按垂直切片推进：

1. 固定语言中立的 Domain Command、Domain Event、Temporal Workflow、Runner 和 Connector 合同；
2. 新增 Verrail 领域表、Outbox 和 Temporal Workflow，不立即重命名全部上游表；
3. 使用版本化兼容映射读取现有 Company/Project/Issue/Agent/Run 数据；
4. 新 UI 只通过 Verrail API 使用 Target/Submission/Artifact/Evidence 语义；
5. 每个切片完成回填、对账、Workflow replay、权限测试和回滚路径后停止旧写入；
6. 所有调用方迁移完成后删除旧投影、Sweeper 和兼容代码。

禁止长期双向写入两套权威模型。迁移期必须有指标显示旧路径调用量与不一致数量。

## 10. Go 目标内核与重构边界

TypeScript Server 是当前兼容基座。Go 是新 Verrail 领域与编排内核的目标语言，范围为 Domain API、Temporal Worker、Execution Gateway、Runner 和适合独立部署的后台 Worker。

当前 Go 垂直切片位于 `services/domain-api`。Domain API 是 `verrail_targets`、`verrail_target_revisions`、`verrail_command_receipts`、`verrail_audit_events` 与创建时 outbox 事实的唯一写入者。TypeScript Server 保留 Session/Board 鉴权边缘，以内部 bearer credential 和 Principal context 调用 Go HTTP API，并从原生表与兼容投影合并统一 Target 读取结果。本地源码运行时由 Server 管理 loopback Go sidecar；外部部署通过成对的 `VERRAIL_DOMAIN_API_URL` 与 `VERRAIL_DOMAIN_API_TOKEN` 配置独立服务。

独立的 Go `orchestration-worker` 领取已提交的 Target outbox 事件，并通过稳定 Workflow ID 和版本化 Signal 启动或通知 `TargetWorkflow`。Dispatcher 的 claim token、lease、per-aggregate ordering、退避和 failed 状态保存在 PostgreSQL；Temporal Workflow 只维护有界编排状态与事件去重。该切片不激活 Graph、不启动 Run、不改变现有 Issue、Case、Heartbeat 或 Recovery 写路径。完整合同见 [`temporal-target-workflow.md`](./temporal-target-workflow.md)。

Go 重构遵守以下边界：

- 以 Verrail v0.2 领域合同为目标，不逐行翻译 Paperclip 路由和 Service；
- React UI、成熟 TypeScript Adapter、Plugin SDK 和不影响标志性闭环的继承能力可以继续运行在 TypeScript Compatibility Service；
- 新 Go 服务先拥有新的 Workspace/Target/Graph/Run/Submission 领域表，旧表只通过兼容 Adapter 读取；
- 同一聚合在任一迁移阶段只有一个写入 Owner，禁止长期双写；
- Temporal Workflow、Domain Command/Event、OpenAPI、Runner Protocol 和 Artifact 接口先于代码稳定；
- 切换采用 Strangler 路由、影子读取、契约测试、按 Workspace 或 Feature Flag 放量和一键回退；
- 只有迁移切片通过数据对账、权限、安全、replay、恢复和负载验证后，TypeScript 写路径才能关闭。

“后端 Go 化”指核心控制平面和执行平面由 Go 承担，不要求把 React UI、所有 Harness Adapter、Plugin 作者 SDK、历史迁移脚本或一次性运维工具机械改写为 Go。工作量与方案比较见 [`adrs/0004-go-control-plane-replatform.md`](./adrs/0004-go-control-plane-replatform.md)。

## 11. 安全边界

- Workspace、Principal、Runner 和 Plugin 使用独立可吊销身份；
- Control Plane 与 Runner 双向认证、加密、防重放并固定协议版本；
- Secret 使用引用和短期 Lease，禁止进入 Prompt、日志和 Artifact；
- Action 绑定参数、资源、风险、发起主体和 Approval；
- HostTrusted 明示弱隔离，不接收不可信代码；
- 强隔离调度必须匹配经过准入的 RuntimeProfile；
- Adapter、Harness、镜像和 Plugin 固定版本、来源 Hash、许可证和 SBOM；
- AuditEvent 追加保存，敏感字段按分类脱敏或仅保存 Hash。

## 12. 可靠性与运维

- Run/RunAttempt、IntegrationRun/IntegrationAttempt、HumanWorkResult、WorkNode、Temporal Workflow 和 Sandbox 使用独立生命周期；
- Lease 超时和 fencing token 解决失联与重复回传；
- Provider `UnknownEffect` 先核验再重试；
- PostgreSQL、对象存储与 Temporal Namespace 按可验证的恢复点和恢复顺序制定备份；
- API、Temporal Service、Worker、Gateway、Runner、Adapter 与 Sandbox 使用统一健康和容量语义；
- 部署必须支持迁移前检查、滚动升级、版本兼容窗口和回滚；
- 关键 SLO 覆盖 API 可用性、调度延迟、运行恢复、Artifact 持久化和审计完整性。

## 13. 实施边界

近期只引入四个有明确责任的运行单元：Compatibility API、Verrail Domain/Temporal Worker、Execution Gateway/Runner 和 PostgreSQL/Object Storage/Temporal 基础设施。先完成一个 TargetRevision 到 Submission/Acceptance 的真实闭环，再扩展 Adapter、Connector、Sandbox 和 Cloud 规模。任何进一步拆分都必须证明它降低交付风险或打开企业场景，而不是只增加架构层数。
