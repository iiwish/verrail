# ADR-0003：采用 Temporal 作为耐久编排内核

状态：`Accepted`

日期：2026-08-26

## 上下文

Verrail 的 Target 和 Run 生命周期包含长时间等待、人工决策、外部系统回调、重试、超时、取消、暂停、恢复和跨进程执行。当前 TypeScript 基座使用 PostgreSQL 状态表、进程内定时器、周期扫描、启动恢复、租约和补偿逻辑完成这些职责。该实现证明了产品可以工作，但编排语义分散在调度、恢复、路由和服务层，难以作为长期控制平面内核。

Temporal Workflow 通过持久化 Event History 和确定性重放恢复编排状态；Activity 承载数据库、网络和进程等非确定性操作。该模型与 Verrail 的长生命周期工作、人工门禁和可恢复执行相匹配。

## 决策

1. Temporal 是 Verrail 新建 Target、Agent Run 和跨节点等待编排的必选基础设施；
2. PostgreSQL 是业务事实源，保存 TargetRevision、GraphRevision、WorkNode、Run、IntegrationRun、HumanWorkResult、Artifact、Evidence、VerificationResult、Submission、Review、Acceptance、权限、预算和审计事实；
3. Temporal Event History 是编排进度的事实源，不取代业务数据库，不作为查询模型或审计记录的唯一来源；
4. `TargetWorkflow` 负责一个 Target 的图推进、IntegrationRun 协调、HumanWorkResult 与门禁等待、暂停、恢复、取消和子 Run 协调；
5. `RunWorkflow` 负责一次 Run 的 Attempt 调度、超时、重试、取消、Runner 交付和未知结果协调；
6. 业务事务通过 Transactional Outbox 发布待编排事件，Dispatcher 使用稳定 Workflow ID 启动或 Signal Workflow；
7. Workflow 通过幂等 Activity 调用版本化领域命令。领域事务提交成功后，再以幂等 Signal 或查询恢复 Workflow 进度；
8. HumanWorkResult、人工决策、Review、Acceptance 和外部 Provider 回调先写入 PostgreSQL，再把事实标识 Signal 给 Workflow；
9. 外部副作用统一通过 Capability Gateway 执行，保留 idempotency key、lease、fencing、effect receipt 和未知结果协调；
10. 系统不宣称跨 PostgreSQL、Temporal 和外部 Provider 的 exactly-once。每个边界都使用至少一次投递、幂等命令和可协调事实；
11. Workflow History 只保存稳定标识、版本、哈希和编排所需的小型数据。Secret、源码、Artifact 正文、敏感 Evidence 和大对象不进入 History；
12. Workflow 类型、Signal、Query、Activity、Search Attribute 和 Payload Schema 全部版本化。Worker 发布采用兼容部署和 Workflow versioning；
13. 长生命周期 Workflow 定义 Continue-As-New 和 History 大小阈值；
14. 本地开发、开源自托管和 Verrail Cloud 使用相同编排合同，部署拓扑和运维等级可以不同。

## 一致性边界

一次领域状态变更按以下顺序形成可恢复链路：

1. PostgreSQL 事务提交领域事实和 Outbox；
2. Dispatcher 以事件 ID 作为幂等键启动或 Signal Workflow；
3. Workflow 决定下一条合法编排命令；
4. Activity 调用领域服务或 Capability Gateway；
5. 领域服务使用命令 ID、预期版本和 fencing 校验提交事实；
6. 重复投递返回已存在的结果，不重复产生业务副作用。

Temporal 故障不阻止已经提交的业务事实被查询。PostgreSQL 故障不允许 Workflow 猜测或伪造业务结果。两者恢复后由 Outbox、幂等 Activity 和协调任务继续推进。

## 不由 Temporal 取代的职责

- Graph Engine 对 WorkNode 激活条件和合法状态转换的业务权威；
- PostgreSQL 的领域约束、版本检查和多租户隔离；
- Execution Gateway、Runner lease、fencing 和运行环境隔离；
- Capability Gateway 对外部副作用的权限、策略和回执；
- Artifact、Evidence、Review、Acceptance 和 AuditEvent 合同；
- Provider 已接收但响应丢失等未知副作用的业务协调。

## 落地顺序

1. 建立本地 Temporal 开发环境、Worker 骨架、版本化 Payload 合同、Outbox 和可观测性；
2. 以一条新的 Target 到 Run 垂直切片实现 `TargetWorkflow` 和 `RunWorkflow`；
3. 接入人工 Gate、Review、Acceptance、超时、重试和取消；
4. 将新流程的定时器、计划重试和启动恢复迁入 Temporal；
5. 在行为对照、故障注入和回放验证通过后，删除对应的兼容扫描器；
6. 保留旧 Paperclip 路径的兼容服务，直到相关领域切片完成迁移。

## 后果

- 长时间等待和进程重启成为编排平台的原生能力；
- 需要运行 Temporal Service、数据库、Worker、升级和可观测性体系；
- Workflow 确定性、History 体积、版本兼容和 Payload 隐私成为发布门禁；
- PostgreSQL 与 Temporal 之间必须维护可观测的最终一致性和修复工具；
- 当前调度与恢复代码按垂直切片退役，不执行一次性替换。

## 否决方案

- 继续扩展进程内定时器和周期扫描：恢复语义继续分散，长期维护成本过高；
- 让 Temporal 成为业务事实数据库：削弱关系约束、查询、权限和可审阅领域事实；
- 在 Workflow 中直接执行数据库或网络副作用：破坏确定性和可靠重放；
- 双写 PostgreSQL 与 Temporal 后假设 exactly-once：故障窗口无法被可靠消除；
- 一次性迁移所有现有 heartbeat 和 recovery 路径：回归面过大，无法证明行为等价。

## 参考

- [Temporal Workflow](https://docs.temporal.io/workflows)
- [Temporal Activity](https://docs.temporal.io/activities)
- [Temporal Go SDK](https://docs.temporal.io/develop/go)
- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript)
