# Verrail 运行本体契约

版本：0.1

状态：`Ready_For_User_Review`

最后更新：2026-08-25

## 1. 目的

本文定义 Verrail 的核心名词、关系、状态和不变量。数据库表名、API 路径、UI 文案和 Provider 标识可以在迁移期不同，但不得改变这些语义。

## 2. 语义层次

### 组织层

`Workspace`、`Principal`、`RoleBinding`、`Project`、`Policy`。

### 目标层

`Target`、`Stage`、`Outcome`、`AttentionItem`。

### 计划与执行层

`WorkGraph`、`GraphRevision`、`WorkNode`、`NodeExecution`、`Invocation`、`Run`、`RunAttempt`。

### Agent 生命周期层

`AgentDefinition`、`AgentVersion`、`Deployment`、`AgentSession`、`EvaluationRun`、`ImprovementProposal`。

### 交付证明层

`ArtifactContract`、`Artifact`、`ArtifactRevision`、`Evidence`、`DeliveryReview`、`Acceptance`。

### 执行基础设施层

`RuntimePool`、`Runner`、`ExecutionLease`、`SandboxLease`、`WorkspaceVolume`、`EnvironmentManifest`。

### 外部 Effect 层

`Connector`、`Connection`、`Capability`、`Grant`、`Action`、`Approval`、`CredentialRef`、`CredentialLease`。

## 3. 核心实体

### Workspace

租户级安全、数据和配置边界。所有业务对象必须直接或间接属于一个 Workspace。

### Principal 与 RoleBinding

Principal 是 Human、Group、ServiceAccount、Agent Deployment 或 Runner Identity。RoleBinding 把 Principal 绑定到 Workspace 或明确 ResourceScope 下的角色。身份和责任角色分开建模。

### Project

长期交付方向的组织容器，拥有 Target、成员投影、默认策略和资源引用。Project 不自动放大成员权限。

### Target

可被验收的结果，至少包含 Goal、OutcomeOwner、AcceptanceCriteria、RiskLevel、Deadline 和状态。状态为：

```text
draft -> ready -> active -> verifying -> awaiting_acceptance -> accepted
                    |             |                |
                    +-> blocked <-+----------------+
                    +-> canceled
```

`accepted` 只能由有效 Acceptance 和全部强制 Gate 推导，不能由 Agent 或普通状态更新直接写入。

### Stage

Target 内稳定的交付阶段，拥有顺序、进入条件、退出条件和聚合状态。Stage 用于人类理解与导航；Graph Engine 仍以 WorkNode 和依赖作为调度事实。

### WorkGraph 与 GraphRevision

WorkGraph 是 Target 的计划容器。GraphRevision 是不可变节点与边快照，绑定目标、输入、角色解析规则、预算、策略注入和来源提案。重规划创建新 Revision，不原地修改已执行版本。

### WorkNode 与 NodeExecution

WorkNode 定义一项责任、输入、输出、完成条件、证据要求、超时和预算。NodeExecution 是某个 GraphRevision 下的执行实例，状态为：

```text
pending -> ready -> leased -> running -> succeeded
                    |          |       -> failed
                    |          |       -> blocked
                    |          +------ -> canceled
                    +----------------- -> expired
```

WorkNode 类型固定为 `AgentTask`、`HumanTask`、`DecisionGate`、`ReviewGate`、`AcceptanceGate` 和 `IntegrationTask`。新增类型必须说明责任主体和不可伪造的完成依据。

### AgentDefinition、AgentVersion 与 Deployment

AgentDefinition 是可编辑设计容器。AgentVersion 是不可变发布快照，固定 Runtime、模型、Prompt、Skill、工具、输出 Schema、Capability 上限和供应链信息。Deployment 是生产调用身份，固定一个 AgentVersion 和运行配置 Revision。

### Invocation、AgentSession、Run 与 RunAttempt

Invocation 是一次经过授权的调用意图。AgentSession 是 Agent 的逻辑上下文边界，不等于聊天 Thread 或 Harness Session。Run 是持久业务执行记录；RunAttempt 是一次可重试的具体执行。每个 Attempt 固定 EnvironmentManifest、ExecutionLease、Adapter/Harness Version 和 fencing token。

### EvaluationRun 与 ImprovementProposal

EvaluationRun 在版本化评测集上比较 AgentVersion 的质量、成本、延迟和安全结果。ImprovementProposal 引用来源 Run/Evidence，提出对 AgentDefinition、Skill 或配置的修改；未经人类批准不得发布新 AgentVersion。

### ArtifactContract、Artifact 与 ArtifactRevision

ArtifactContract 定义交付类型、结构、必需字段、渲染方式和证据要求。Artifact 是稳定交付对象；ArtifactRevision 是内容寻址的不可变版本，至少绑定内容 Hash、来源 Target/WorkNode/Run、Base Revision 和创建主体。

### Evidence

Evidence 是对特定声明的结构化证明，记录类型、来源、生成主体、对象 Hash、时间、有效期和原始引用。Agent 自述可以作为低信任 Observation，不能冒充 CI、扫描器或人工核验结果。

### DeliveryReview 与 Acceptance

DeliveryReview 绑定一个或多个固定 ArtifactRevision 和 Evidence，记录风险、未证明事项、评论和 Reviewer 结论。Acceptance 绑定 DeliveryReview、AcceptanceCriteria 和 AcceptanceAuthority。源 Revision、Evidence 或条件变化后，旧 Acceptance 不再满足当前 Target 门禁。

### RuntimePool、Runner 与 Lease

RuntimePool 表示区域、信任域、网络、数据驻留和 RuntimeProfile 的调度池。Runner 是主动连接控制平面的执行节点。ExecutionLease 授权一个 Attempt 在指定 Runner 上执行；SandboxLease 进一步绑定隔离实例。所有提交使用 fencing token 防止旧租约覆盖新状态。

### WorkspaceVolume 与 EnvironmentManifest

WorkspaceVolume 是可恢复的任务工作状态，生命周期独立于 Runtime 进程。EnvironmentManifest 是不可变环境摘要，包含 OS/Arch、镜像或宿主信息、工具版本、Adapter/Harness、网络策略、挂载、Secret 引用和来源 Hash。

### Connector、Connection 与 Action

Connector 定义 Provider 能力和事件映射；Connection 是 Workspace 对 Provider 的已配置连接。Agent 只提出结构化 Action，Capability Gateway 根据 Deployment、Grant、ResourceScope、Policy、风险和 CredentialLease 决定是否执行。

## 4. 五类授权

| 授权 | 回答的问题 | 典型主体 |
| --- | --- | --- |
| `InvocationAuthority` | 谁可以启动、读取或取消某个 Deployment/Target/Run | Human、ServiceAccount、Connector |
| `ExecutionAuthority` | 哪个 Deployment/Runner 可以执行某个 WorkNode | Graph Engine、Scheduler、Runner |
| `DecisionAuthority` | 谁可以完成 HumanTask 或 DecisionGate | Human、Group |
| `ApprovalAuthority` | 谁可以允许一个结构化外部 Action 发生 | Human、Policy-authorized service |
| `AcceptanceAuthority` | 谁可以接受特定 DeliveryReview | Outcome Owner、指定 Group |

五类授权独立计算。拥有一种授权不推导出其他授权。Agent 不能批准自己的高风险 Action，也不能验收自己的交付。

## 5. 关系

```text
Workspace
  owns Project, AgentDefinition, Deployment, RuntimePool, Connector, Policy

Project
  owns Target

Target
  owns Stage, WorkGraph, Artifact, Outcome, Timeline

WorkGraph
  owns immutable GraphRevision

GraphRevision
  contains WorkNode

WorkNode
  creates NodeExecution

NodeExecution
  may create Invocation -> Run -> RunAttempt

RunAttempt
  uses Deployment + AgentVersion + ExecutionLease + EnvironmentManifest
  produces ArtifactRevision and Evidence

ArtifactRevision + Evidence
  form DeliveryReview -> Acceptance
```

## 6. 系统不变量

1. 所有业务对象必须属于且只属于一个 Workspace；
2. 生产 Run 必须固定不可变 AgentVersion 和 Deployment Revision；
3. 已执行 GraphRevision 不得原地修改；
4. Graph Engine 是节点激活与权威状态转换的唯一写入边界；
5. Director 只能提交提案，不能绕过 Policy、Gate 或直接完成节点；
6. AgentTask、HumanTask、Gate 和 IntegrationTask 的完成依据不可互相伪造；
7. 每个外部 Effect 必须通过结构化 Action，使用稳定幂等键并形成 AuditEvent；
8. Invocation、Execution、Decision、Approval 和 Acceptance 授权不得合并；
9. ArtifactRevision、Evidence、Review 和 Acceptance 必须绑定内容或对象 Hash；
10. 源内容变化后，旧 Review/Acceptance 不能自动适用；
11. Runner、Adapter、Harness Session 和 Transcript 不是业务事实源；
12. Runner 不直接访问控制平面数据库；
13. 旧 Lease 的结果不得覆盖使用更高 fencing token 的 Attempt；
14. Secret 明文不得写入 Graph、Run、日志、Artifact 或 AuditEvent；
15. WorkspaceVolume 可以延续，Runtime 进程和 Sandbox 可以回收；
16. 任何 `UnknownEffect` 必须先核验 Provider 状态，不能盲目重放；
17. `accepted` Target 必须可从版本、证据、评审和验收事实重建；
18. 团队可信记忆只能来自已验收交付，并保留来源 Run 与 Artifact 引用。

## 7. 兼容边界

当前 TypeScript 基座中的 `company`、`project`、`issue`、`agent`、`heartbeat_run`、`approval` 和 `work_product` 是迁移输入。迁移层可以读取或双写兼容投影，但 Verrail 新功能不得继续扩大 CEO、组织图、单指派 Issue 或通用 Board Approval 语义。

兼容映射必须版本化、可观测、可回滚，并明确终止条件。任何一次迁移都不能同时改变存储、API、权限和 UI 语义而缺少独立验证。
