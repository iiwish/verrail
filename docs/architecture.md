# Verrail 架构契约

版本：0.1

状态：`Ready_For_User_Review`

最后更新：2026-08-25

## 1. 架构目标

Verrail 采用 TypeScript 控制平面、PostgreSQL 事实库、对象存储和独立执行平面。架构优先保证：

1. 交付事实可恢复、可审计、可验收；
2. Agent Harness、Sandbox Backend 和 Provider 可替换；
3. 开源自托管、托管 Cloud 和客户 VPC 执行使用同一领域合同；
4. 企业代码、凭证和网络边界可以留在客户环境；
5. 现有 Paperclip 基座可以渐进重构，不以大爆炸重写阻塞产品验证；
6. 未来 Go 服务通过协议提取，而不是复制业务模型或双写事实库。

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

控制平面拥有业务事实。Execution Gateway、Runner、Sandbox 和 Adapter 只执行带租约的命令并回传候选事件、结果和证据。

## 3. 当前工程基座

| 层 | 基座 | 当前责任 |
| --- | --- | --- |
| Web | React + Vite + TanStack Query | 操作台、设置、运行与审计界面 |
| Server | Node.js + TypeScript + Express | REST API、领域服务、Scheduler、Adapter 调用 |
| Database | PostgreSQL + Drizzle | 权威关系事实、迁移、事务与查询 |
| Object Storage | Local/S3-compatible | Artifact、附件、日志和大对象 |
| Adapters | TypeScript packages | Codex、Claude、Cursor、Process、HTTP 等 Harness 接入 |
| Plugins | Plugin SDK | Provider、Sandbox、运行时服务和扩展能力 |
| CLI | TypeScript CLI | 安装、配置、诊断和控制平面操作 |

仓库内部仍有 `paperclipai` 包名、环境变量和领域命名。它们是兼容技术标识，按模块逐步迁移，不定义 Verrail 的产品语义。

## 4. 控制平面模块

### Identity and Tenant

负责 Workspace、Human、Group、ServiceAccount、RoleBinding、SSO/SCIM 边界和会话。所有数据访问先确定 Workspace，再校验 ResourceScope。

### Delivery Domain

负责 Project、Target、Stage、Outcome、AttentionItem 和 Timeline。这里定义用户可见的交付状态，不直接运行 Agent。

### Graph Engine

负责 GraphProposal 校验、GraphRevision、节点激活、角色解析、依赖、强制 Gate、Node Lease、重规划和恢复。Director 是计划提议者，Graph Engine 是唯一状态裁决者。

### Agent Lifecycle

负责 AgentDefinition、AgentVersion、Deployment、EvaluationRun、ImprovementProposal 和版本发布/回滚。Harness 私有配置通过 Adapter Manifest 固定，但不成为身份或权限事实。

### Artifact and Evidence

负责 ArtifactContract、ArtifactRevision、内容 Hash、Materialization、Evidence、DeliveryReview、ReviewComment 和 Acceptance。大对象写入 Object Store，关系、Hash 和生命周期写入 PostgreSQL。

### Capability Gateway

负责 Capability、Grant、Policy、Action、Approval、CredentialLease、Provider Effect 幂等与未知结果核验。所有外部写操作和敏感平台自操作经过此边界。

### Runtime Control

负责 RuntimePool、Runner、能力与容量、ExecutionLease、SandboxLease、WorkspaceVolume 和 EnvironmentManifest。它通过 Execution Gateway 发命令，不直连 Harness 或客户数据库。

### Audit and Observability

负责不可变 AuditEvent、领域事件、Run Event、Trace 关联、指标和安全事件。产品 Timeline 是领域投影，不等同于原始日志。

## 5. 数据与一致性

### PostgreSQL

PostgreSQL 是唯一领域事实库。Graph 状态、Run、租约、授权、Artifact 元数据、Evidence、Review、Acceptance 和 AuditEvent 必须在事务边界内保持一致。

领域命令使用 Transactional Outbox 发布后续工作。消费者必须容忍重复投递，并使用稳定幂等键。长任务不依赖单个 Node.js 进程的内存状态。

### Object Storage

Artifact 内容、附件、大日志和 Checkpoint 存入 Local 或 S3-compatible Storage。数据库保存租户、类型、大小、Hash、加密、保留策略和对象键。对象写入采用暂存、校验、提交元数据和异步回收流程。

### Search and Analytics

MVP 使用 PostgreSQL 投影和索引。搜索引擎、数据仓库或流系统只有在真实规模证明后引入，不能形成第二套业务写模型。

## 6. 执行链路

```text
Graph Engine
  -> Outbox Command
  -> Runtime Scheduler
  -> ExecutionLease + fencing token
  -> Execution Gateway
  -> Runner
  -> SandboxDriver / WorkspaceManager
  -> AgentRuntimeAdapter
  -> Harness
  -> normalized events / result / artifacts
  -> validation
  -> domain state + Evidence + AuditEvent
```

命令和事件都携带 Workspace、Target、NodeExecution、Run、Attempt、Lease、协议版本和 Correlation ID。Runner 只能提交租约允许的结果。

详细合同见 [`execution-runtime.md`](./execution-runtime.md)。

## 7. Cloud 与企业拓扑

```text
Verrail Cloud Plane
  Account | Billing | SSO | Fleet | Region | Quota
                         |
                  Tenant Control Cell
        TypeScript API + PostgreSQL + Object Storage
                         |
                  Execution Gateway
             +-----------+-----------+
             |                       |
   Managed CubeSandbox       Customer VPC Runner
                                     |
                             Private Sandbox/Host
```

### Open-source self-hosted

单机或小团队使用同一 Server 构建、PostgreSQL、对象存储和一个或多个 Runner。Docker Compose 是首选入口。即使 Server 与 Runner 同机，也使用不同身份和协议边界。

### Managed Cloud

Cloud Plane 管理账户、计费、配额、区域与租户单元生命周期。Tenant Control Cell 承担租户业务事实。首发可以共享基础设施，但逻辑合同必须允许高价值或受监管租户独立 Cell。

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

1. 新增 Verrail 领域表和服务，不立即重命名全部上游表；
2. 使用版本化兼容映射读取现有 Company/Project/Issue/Agent/Run 数据；
3. 新 UI 只通过 Verrail API 使用 Target/Graph/Artifact 语义；
4. 每个切片完成回填、对账、权限测试和回滚路径后停止旧写入；
5. 所有调用方迁移完成后删除旧投影和兼容代码。

禁止长期双向写入两套权威模型。迁移期必须有指标显示旧路径调用量与不一致数量。

## 10. 渐进式 Go 演进

TypeScript 控制平面是当前产品基座。Go 只在以下条件同时成立时引入：

- 边界已有稳定、语言中立协议；
- 性能、资源、隔离或单二进制运维收益经过测量；
- 服务不需要共享内存或直接访问 TypeScript 内部模块；
- 数据所有权、幂等、错误、版本和回滚合同完整；
- 提取不要求复制领域事实或长期双写。

优先候选为 Execution Gateway、Runner Agent、Lease/Fencing 服务、日志/Artifact 流和高吞吐调度 Worker。Project、Target、Graph、权限、Review 和 Acceptance 先保留在 TypeScript 模块化控制平面中。

迁移使用 Strangler 模式：接口固定、影子读取或结果对比、小流量切换、可回退路由、停止旧实现。全量 Go 重写不属于路线目标。

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

- Run、Attempt、Node 和 Sandbox 使用独立生命周期；
- Lease 超时和 fencing token 解决失联与重复回传；
- Provider `UnknownEffect` 先核验再重试；
- 数据库与对象存储按同一恢复点目标制定备份；
- Server、Gateway、Runner、Adapter 与 Sandbox 使用统一健康和容量语义；
- 部署必须支持迁移前检查、滚动升级、版本兼容窗口和回滚；
- 关键 SLO 覆盖 API 可用性、调度延迟、运行恢复、Artifact 持久化和审计完整性。

## 13. 实施边界

近期保持模块化单体，不提前拆分微服务。先完成一个 Target 到 Acceptance 的真实闭环，再扩展 Adapter、Connector、Sandbox 和 Cloud 规模。任何基础设施建设都必须证明它降低交付风险或打开企业场景，而不是只增加架构层数。
