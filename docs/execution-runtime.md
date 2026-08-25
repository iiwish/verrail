# Verrail 执行运行时契约

版本：0.1

状态：`Ready_For_User_Review`

最后更新：2026-08-25

## 1. 目的

执行平面让 Verrail 在托管 Linux、开发者机器或客户 VPC 中运行 Agent，同时保持同一权限、租约、产物、证据和审计语义。执行资源可以替换，业务事实不能下沉。

## 2. 组件

### Execution Gateway

控制平面和 Runner 之间唯一远程边界，负责认证、协议协商、命令投递、心跳、事件回传、背压和连接恢复。Gateway 不拥有 Graph 或 Run 状态。

### RuntimePool

调度池，声明区域、信任域、网络、数据驻留、可用 RuntimeProfile、容量和成本。Scheduler 先选择 Pool，再选择 Runner。

### Runner

客户或平台管理的 Headless 执行节点。Runner 主动建立出站连接，上报能力和容量，验证 Lease，管理 Workspace/Sandbox，调用 Adapter，并回传规范化事件。

### SandboxDriver

隔离后端接口，至少支持 `create/start/exec/stream/checkpoint/stop/destroy/inspect`。Host 进程、容器、CubeSandbox 或 Kubernetes Job 都只能通过该接口接入。

### AgentRuntimeAdapter

Harness 适配边界，至少支持 `probe/start/resume/respond/cancel/stream/collectResult`。Adapter 不访问控制平面数据库，不自行授予工具权限，不直接完成 Graph 节点。

## 3. RuntimeProfile

| Profile | 隔离承诺 | 适用场景 |
| --- | --- | --- |
| `HostTrusted` | 目录、进程、环境和策略约束，不提供不可信代码强隔离 | 开发者本机、专属可信主机、早期自托管 |
| `ContainerIsolated` | 经准入的容器或 MicroVM 隔离、网络和资源策略 | 托管执行、互联网输入、多人租户 |
| `PrivateIsolated` | 客户 VPC 内的经准入隔离后端和数据出站限制 | 企业源码、内网资源、受监管数据 |
| `KubernetesJob` | 由集群 Backend 按 Attempt 创建短期工作负载 | 后续弹性与企业集群集成 |

`Managed`、`Private` 和 Region 是部署属性，不代表隔离等级。调度不得把弱隔离 Profile 当作强隔离降级项。

## 4. 执行生命周期

1. Graph Engine 创建 ready NodeExecution；
2. Scheduler 根据 RuntimeRequirement、数据策略、容量和成本选择 RuntimePool；
3. 控制平面创建 ExecutionLease、Attempt 和 fencing token；
4. Gateway 将带签名命令投递给指定 Runner；
5. Runner 验证租约，挂载 WorkspaceVolume，创建或恢复 Sandbox；
6. Runner 生成 EnvironmentManifest 并启动 Adapter/Harness；
7. 事件按 Cursor 回传，控制平面校验并持久化；
8. Artifact 先校验类型、大小和 Hash，再形成 ArtifactRevision；
9. RunResult 与要求的 Evidence 通过领域校验后推进 NodeExecution；
10. Runtime 进程和 Sandbox 回收，Workspace 按 RetentionPolicy 保留或清理。

## 5. Lease 与恢复

- ExecutionLease 固定 Workspace、RunAttempt、Runner、RuntimeProfile、期限、资源和 fencing token；
- Runner 只能为活动租约回传事件和结果；
- 心跳丢失后先标记 `suspect`，超过宽限期再过期租约；
- 新 Attempt 使用更高 fencing token，旧 Attempt 的迟到结果只进入审计，不改变权威状态；
- 事件携带单调 Cursor，重复事件幂等，缺口触发补传或明确降级；
- Workspace 与 Checkpoint 恢复必须校验 Base Revision、内容 Hash 和 EnvironmentManifest 兼容性；
- 取消需要可观察的 `requested -> acknowledged -> terminated` 过程，不能只改数据库状态。

## 6. Workspace、缓存与产物

Runtime 进程、Sandbox、WorkspaceVolume、CacheEntry 和 ArtifactRevision 是不同生命周期：

- Runtime 进程等待人类输入时可以释放；
- Sandbox 可销毁并从 Workspace/Checkpoint 恢复；
- WorkspaceVolume 在 Target 的恢复窗口内保留未提交工作；
- CacheEntry 可重建，不进入交付事实；
- ArtifactRevision 不可变，并在对象存储和 PostgreSQL 中保留 Hash 与来源；
- StorageJanitor 不得删除活动租约、未完成 Review、Legal Hold 或有效 RetentionPolicy 覆盖的内容。

## 7. CubeSandbox 采用门槛

CubeSandbox 是 Linux 强隔离候选，通过 `SandboxDriver` 评估，不成为产品领域对象或唯一后端。生产准入需要完成：

### 功能 Spike

- x86_64 与 ARM64 的创建、执行、流式日志、取消、暂停、恢复和销毁；
- Workspace 挂载、Artifact 导出、网络策略、资源限制和进程树清理；
- Codex Adapter 的长任务、交互审批和中断恢复；
- Runner 与 Sandbox 同时崩溃后的幂等收敛。

### 安全 Spike

- 文件、进程、网络、设备和内核隔离边界；
- Secret Lease 的注入、使用、撤销和日志脱敏；
- 恶意仓库、Prompt Injection、符号链接、路径穿越和大文件攻击；
- 镜像来源、签名、SBOM、漏洞响应和宿主补丁责任。

### 性能与运维 Spike

- 冷启动、热启动、Checkpoint 恢复、编译负载和浏览器负载；
- CPU、内存、磁盘、网络和并发密度的真实工作负载基线；
- Paused Sandbox 的资源回收、排队和配额行为；
- 日志、指标、故障诊断、升级、回滚和容量扩展；
- 许可证、维护活跃度和私有化支持成本。

准入结果只能是 `Adopt`、`AdoptWithConstraints` 或 `Reject`，并记录独立 ADR。未通过准入的任务继续使用明确标记的 HostTrusted 或其他已验证后端。

## 8. 私有 Runner 与数据出站

Private Runner 默认只回传状态、计量、结构化错误、Evidence 摘要和内容 Hash。DataEgressPolicy 分别控制：

- Prompt 与 ContextSnapshot；
- Source、Diff 与 Artifact 内容；
- 原始日志与 Transcript；
- 环境与依赖清单；
- Provider 返回体和内部地址；
- Secret、Token 和身份信息。

控制平面不得要求长期客户凭证。`runtime-local` CredentialRef 在客户环境解析，控制平面只保存引用、策略和审计。需要上传 Artifact 时，Runner 使用短期、限对象键和限大小的上传授权。

## 9. 协议要求

- 使用语言中立、版本化的消息 Schema；
- 明确兼容窗口、能力协商和拒绝原因；
- 命令携带稳定幂等键，事件携带 Cursor；
- 大日志和 Artifact 使用分块、校验和背压；
- Runner 升级支持 drain，不中断无法恢复的 Attempt；
- 所有远程错误归一为可重试、不可重试、未知 Effect 或策略拒绝；
- Contract Test 覆盖 TypeScript Gateway 与未来 Go 实现。

## 10. 验收标准

1. 控制平面重启后仍能恢复活动 Run；
2. Runner 断线和重连不会重复产生外部 Effect；
3. 旧租约结果不能覆盖新 Attempt；
4. HostTrusted 和强隔离任务不会错误互换；
5. Private Runner 能证明禁止出站的数据未离开客户环境；
6. Sandbox 销毁后 Run、Artifact、Evidence 与 Audit 仍可完整追溯；
7. 同一 AgentRuntimeAdapter 合同可在本地 Runner 与托管 Linux Runner 运行；
8. CubeSandbox 未通过全部准入项前不会被标记为企业强隔离生产能力。
