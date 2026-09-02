# Verrail 运行本体契约

版本：0.4

状态：`Confirmed`

最后更新：2026-09-01

## 1. 目的

本文定义 Verrail 的核心名词、关系、状态和不变量。数据库表名、API 路径、UI 文案、Temporal Workflow 和 Provider 标识可以采用不同实现形式，但不得改变这些业务语义。

Verrail 的领域中心是可验收交付：Target 固定责任，Submission 固定本次交付候选，Evidence 证明声明，Acceptance 裁决完成。Agent、Work Graph、Temporal、Runner 和 Harness 都是实现交付的手段。

## 2. 语义层次

### 组织与访问层

`Workspace`、`Principal`、`RoleBinding`、`Collection`、`Policy`。

### 交付责任层

`Target`、`TargetRevision`、`Stage`、`Outcome`。

### 计划与执行层

`WorkGraph`、`GraphRevision`、`WorkNode`、`Invocation`、`Run`、`RunAttempt`、`IntegrationRun`、`IntegrationAttempt`、`HumanWorkResult`。

### Agent 生命周期层

`AgentDefinition`、`AgentVersion`、`Deployment`、`AgentSession`、`EvaluationRun`、`ImprovementProposal`。

### 交付证明层

`AcceptanceCriterion`、`Claim`、`Evidence`、`VerificationResult`、`ArtifactContract`、`Artifact`、`ArtifactRevision`、`Submission`、`DeliveryReview`、`Acceptance`。

### 执行基础设施层

`RuntimePool`、`Runner`、`ExecutionLease`、`SandboxLease`、`WorkspaceVolume`、`EnvironmentManifest`。

### 外部 Effect 层

`Connector`、`Connection`、`Capability`、`Grant`、`ActionRequest`、`ActionApproval`、`EffectReceipt`、`CredentialRef`、`CredentialLease`。

### 产品投影层

`AttentionItem`、`Timeline`、`StageProgress`、`DeliveryHealth`。这些对象由领域事实计算，不拥有独立业务真相。

### 交互上下文层

`Conversation`、`ConversationMessage`、`ProviderConversationBinding`、`ConversationContextBinding`、`TargetCreationDraft`。这些对象保存用户与系统的交互连续性、目标草拟状态并引用领域对象，不拥有交付、执行、证明、批准或验收事实。

## 3. 核心实体

### Workspace

租户级安全、数据和配置边界。所有业务对象必须直接或间接属于且只属于一个 Workspace。

默认 Workspace 由部署后端按用户或单租户实例幂等供给。产品可以在只有一个可访问 Workspace 时隐藏选择界面，但不得省略 Workspace ID、权限检查、数据隔离、审计归属或路由兼容语义。

每个 Workspace 必须有且仅有一个可解析的默认 Agent Deployment，用于未显式绑定 Agent 的 Conversation、Invocation 和初始协调请求。该绑定是 Workspace 配置，不是新的 Principal 类型，也不授予隐式权限。默认 Deployment 必须遵守版本固定、Grant、Policy、预算、审计和最小委派规则；管理员替换默认绑定不改变历史 Message、Run 或 Target 的实际 Agent 身份。Target 的活动 Director RoleSlot 可以解析到默认 Deployment，也可以由 GraphRevision 显式绑定其他 Deployment。

### Conversation、ConversationMessage 与 ContextBinding

Conversation 是 Workspace 内的持久交互线程，记录创建主体、标题、活动或归档状态、置顶状态和最近活动时间。一个 Provider 群聊或私聊通过 ProviderConversationBinding 映射为一个 Conversation；Web Chat 创建独立 Conversation。ConversationMessage 是追加式用户或系统消息；更正或重试产生新消息或明确状态，不静默改写已经形成领域决定的历史。

ConversationContextBinding 把会话显式绑定到 Collection、Target、TargetRevision、Stage、ArtifactRevision、Review、Run 或其他可检查对象。对话可以查询事实、形成建议或提出 Invocation 和 ActionRequest，但领域改变只由相应命令、权限和版本合同生效。Message 可以引用 Run、ActionRequest、Approval、ArtifactRevision、Evidence、Review 和 Acceptance，不能代替这些对象。

Conversation 未显式绑定 Agent 时解析 Workspace 默认 Agent Deployment；每条 Agent 回复记录实际 Deployment/兼容 Agent 身份和运行来源。默认 Agent 可以提出创建专业 Agent、新 Conversation、Target 或 GraphProposal 的结构化命令，但命令仍分别接受 InvocationAuthority、Capability、Policy、人工确认和幂等校验，不能由普通消息直接生效。

TargetCreationDraft 是 Conversation 中由明确创建目标意图启动的结构化草稿，固定发起 Principal、来源 Message、字段来源和 Draft Version。Agent 可以通过多轮消息更新 Draft 建议，但只有具备权限的人类确认完整版本后，幂等 CreateTarget 命令才创建 Target 与首个 TargetRevision。普通消息不创建 Draft；Draft 也不拥有 Target 状态。详细状态与确认合同见 [`conversation-target-creation.md`](./conversation-target-creation.md)。

### Principal 与 RoleBinding

Principal 是 Human、Group、ServiceAccount、Agent Deployment 或 Runner Identity。RoleBinding 把 Principal 绑定到 Workspace 或明确 ResourceScope 下的角色。身份、工作责任和授权分别计算。

### Collection

Workspace 内的轻量可选 Target 分组，用于聚合、筛选和保存视图。Collection 不拥有 Target，不承载成员、资源、权限或策略，也不是 Target 创建前置。

### Target 与 TargetRevision

Target 是 Workspace 内可被验收结果的稳定身份，可以不关联任何 Collection。TargetRevision 是不可变的责任合同，固定 Goal、Constraints、AcceptanceCriteria、RiskLevel、Deadline、OutcomeOwner、ResourceRefs 和适用策略摘要。目标、约束、验收条件、资源或责任边界变化必须创建新 Revision。

Target 状态为：

```text
draft -> ready -> active -> verifying -> awaiting_acceptance -> accepted
                    |             |                |
                    +-> blocked <-+----------------+
                    +-> canceled
```

`accepted` 只能由针对活动 TargetRevision 的有效 Acceptance 和全部强制控制条件推导，不能由 Agent 或普通状态更新直接写入。

### Stage

Stage 是面向人的稳定交付阶段和导航投影。StageTemplate 定义顺序、进入条件和退出条件；Target 的 StageProgress 由活动 GraphRevision、WorkNode、Submission 和 Gate 状态聚合。Stage 不拥有 Artifact、Evidence 或运行状态，也不取代 Graph Engine 的依赖裁决。

### WorkGraph 与 GraphRevision

WorkGraph 是 Target 的计划容器。GraphRevision 是不可变节点与边快照，必须绑定一个 TargetRevision，并记录输入、角色解析、预算、策略注入和来源提案。重规划创建新 Revision，不原地修改已激活版本。

### WorkNode

WorkNode 定义责任、输入、输出、完成条件、证据要求、超时和预算。WorkNode 分为两类：

| 类别 | 类型 | 完成语义 |
| --- | --- | --- |
| `TaskNode` | `AgentTask` | 通过 Run 和 RunAttempt 产生结构化结果、Artifact 或 Evidence |
| `TaskNode` | `IntegrationTask` | 通过 IntegrationRun、IntegrationAttempt 和 Provider 回执产生结果或 Evidence |
| `TaskNode` | `HumanTask` | 由有权 Human 或 Group 提交不可变 HumanWorkResult |
| `GateNode` | `DecisionGate`、`ReviewGate`、`AcceptanceGate`、`PolicyGate` | 由绑定版本的决定、评审、验收或策略结果满足，不创建伪执行 |

不同 TaskNode 使用不同执行事实，不能为了统一列表而伪造成同一种 Run。GateNode 只等待并校验对应领域事实。Agent 不得完成 HumanTask 或 Gate，人类不得伪造 AgentTask Run，Agent 自报不能替代 IntegrationTask 回执。

### Invocation、Run、IntegrationRun、HumanWorkResult 与 AgentSession

Invocation 是一次经过授权的启动、继续、取消或输入意图，可以激活 Target、Deployment 或 WorkNode。

Run 是一个已激活 AgentTask 的持久逻辑执行，一次 Run 可以因重试、失联或改派产生多个 RunAttempt。每个 RunAttempt 固定 Deployment Revision、AgentVersion、EnvironmentManifest、ExecutionLease、Adapter/Harness Version 和 fencing token。

IntegrationRun 是一个已激活 IntegrationTask 的持久逻辑执行，一次 IntegrationRun 可以因 Provider 重试、回调丢失或重新调度产生多个 IntegrationAttempt。每个 IntegrationAttempt 固定 Connector/Integration Version、Connection、外部对象或 Job 引用、幂等键和 Provider Receipt；它不伪造 AgentVersion、Sandbox 或 ExecutionLease。

HumanWorkResult 是 HumanTask 的不可变提交事实，固定 WorkNode、GraphRevision、Principal、输入版本、结构化结果、ArtifactRevision 或附件 Hash 和提交时间。修改结果创建新 HumanWorkResult，不覆盖旧提交；HumanTask 不创建 Agent Run 或虚构 Runner。

AgentSession 是 Agent 的逻辑上下文边界，不等于 Channel Thread、Temporal Workflow Execution 或 Harness Session。上下文延续不得改变 Run 和 Attempt 的业务身份。

### AgentDefinition、AgentVersion 与 Deployment

AgentDefinition 是可编辑设计容器。AgentVersion 是不可变发布快照，固定 Runtime、模型、Prompt、Skill、工具、输出 Schema、Capability 上限和供应链信息。Deployment 是生产调用身份，固定一个 AgentVersion 和版本化运行配置。WorkNode 指派最终绑定到 Deployment Revision，而不是可变 Agent 草稿。

### EvaluationRun 与 ImprovementProposal

EvaluationRun 在版本化评测集上比较 AgentVersion 的质量、成本、延迟和安全结果。ImprovementProposal 引用来源 Run、Submission 或 Evidence，提出对 AgentDefinition、Skill 或配置的修改；未经人类批准不得发布新 AgentVersion。

### AcceptanceCriterion、Claim、Evidence 与 VerificationResult

AcceptanceCriterion 属于 TargetRevision，定义可判定的验收要求和允许的证明方式。Submission 针对每个适用 Criterion 提出 Claim。Evidence 是支持或反驳 Claim 的不可变来源记录，包含类型、生产主体、对象 Hash、时间、有效期、信任等级和原始引用。

VerificationResult 绑定 Criterion、Claim、Evidence 集合和验证器版本，结果为 `passed`、`failed`、`inconclusive` 或 `waived`。`waived` 必须引用具备权限的人类例外决定及有效范围。Agent 自述只能作为低信任 Observation，不能冒充 CI、扫描器或人工核验结果。

### ArtifactContract、Artifact 与 ArtifactRevision

ArtifactContract 定义交付类型、结构、必需字段、渲染方式和证据要求。Artifact 是稳定交付对象；ArtifactRevision 是内容寻址的不可变版本，至少绑定内容 Hash、来源 Target、WorkNode、Run、Base Revision 和创建主体。

### Submission

Submission 是一次不可变的待评审交付候选，固定 TargetRevision、ArtifactRevision 集合、VerificationResult 集合、Commit 或外部对象快照、EnvironmentManifest 摘要和提交主体。Artifact、Evidence、目标条件或外部对象发生实质变化时必须创建新 Submission，不能静默修改已评审候选。

### DeliveryReview 与 Acceptance

DeliveryReview 绑定一个 Submission，记录风险、未证明事项、评论和 Reviewer 结论。Acceptance 绑定 DeliveryReview、Submission、TargetRevision 和 AcceptanceAuthority。新 Submission 或新 TargetRevision 不继承旧 Acceptance。

### RuntimePool、Runner 与 Lease

RuntimePool 表示区域、信任域、网络、数据驻留和 RuntimeProfile 的调度池。Runner 是主动连接执行平面的节点。ExecutionLease 授权一个 RunAttempt 在指定 Runner 上执行；SandboxLease 进一步绑定隔离实例。所有结果提交使用 fencing token 防止旧租约覆盖新状态。

### Connector、ActionRequest 与 EffectReceipt

Connector 定义 Provider 能力和事件映射；Connection 是 Workspace 对 Provider 的已配置连接。Agent 只能提出结构化 ActionRequest。Capability Gateway 根据 Deployment、Grant、ResourceScope、Policy、风险和 CredentialLease 决定是否需要 ActionApproval 并执行。EffectReceipt 记录 Provider 的不可变结果或 `UnknownEffect` 状态。

## 4. Temporal 与业务事实

Temporal 是 Verrail 的耐久编排引擎，负责 Workflow replay、Timer、Retry、Signal、Update、Child Workflow、取消和长时间等待。Temporal 不拥有 Project、Target、GraphRevision、Run、Submission、Evidence、Review、Acceptance、授权或审计的业务真相。

PostgreSQL 事务写入领域事实和 Transactional Outbox。Outbox Dispatcher 使用稳定 Workflow ID 和幂等键启动或通知 Temporal。Temporal Activity 通过版本化领域命令修改 PostgreSQL；外部 Effect 仍经过 Capability Gateway。Temporal Event History 用于恢复编排状态和诊断，不作为用户权限判断、验收或业务查询的唯一来源。

推荐映射：

```text
TargetWorkflow(target_id)
  coordinates active TargetRevision + GraphRevision
  starts RunWorkflow(run_id) for ready AgentTask
  coordinates IntegrationRun through idempotent Activities and provider-backed Signals
  waits for HumanWorkResult and domain-backed Signals for gates, replans and external events

RunWorkflow(run_id)
  coordinates RunAttempt, timeout, retry, cancellation and Runner dispatch
  never bypasses ExecutionLease, fencing or Capability Gateway
```

## 5. 五类授权

| 授权 | 回答的问题 | 典型主体 |
| --- | --- | --- |
| `InvocationAuthority` | 谁可以启动、读取、输入或取消 Deployment、Target 或 Run | Human、ServiceAccount、Connector |
| `ExecutionAuthority` | 哪个 Deployment、RuntimePool 和 Runner 可以执行 WorkNode | Graph Engine、Scheduler、Runner |
| `DecisionAuthority` | 谁可以完成 HumanTask 或 DecisionGate | Human、Group |
| `ApprovalAuthority` | 谁可以允许一个结构化外部 ActionRequest 发生 | Human、Policy-authorized service |
| `AcceptanceAuthority` | 谁可以接受特定 Submission 的 DeliveryReview | Outcome Owner、指定 Group |

五类授权独立计算。界面可以将待人工处理事项统一呈现为 Decision，但后端不得合并其权限或版本绑定。Agent 不能批准自己的高风险 Action，也不能验收自己的交付。

## 6. 关系

规范交付层级固定为：

```text
Workspace
`-- Target
    |-- Work Graph
    |   |-- Run
    |   |-- Artifact
    |   |-- Evidence
    |   `-- Acceptance
    `-- optional association: Collection
```

箭头表示产品归属与导航上下文，不取代各对象的精确版本绑定。Run、ArtifactRevision、Evidence 和 Acceptance 必须继续绑定对应的 TargetRevision、GraphRevision、WorkNode、Submission 或 Claim；Collection 只建立反向可选归类，不拥有这些事实。

```text
Workspace
  owns Target, Collection, AgentDefinition, Deployment, RuntimePool, Connector, Policy, Conversation

Conversation
  owns ConversationMessage
  binds Provider conversation identity and Collection, Target, ArtifactRevision, Review, Run or ActionRequest context
  owns TargetCreationDraft interaction state

Collection
  optionally groups Target

Target
  owns immutable TargetRevision and WorkGraph
  projects StageProgress, AttentionItem, Timeline and Outcome

GraphRevision(targetRevisionId)
  contains TaskNode and GateNode

TaskNode
  AgentTask -> Run -> RunAttempt
  IntegrationTask -> IntegrationRun -> IntegrationAttempt
  HumanTask -> HumanWorkResult

RunAttempt
  uses DeploymentRevision + AgentVersion + ExecutionLease + EnvironmentManifest
  produces ArtifactRevision and Evidence

IntegrationAttempt
  uses ConnectorVersion + Connection + ProviderRef + idempotency key
  produces EffectReceipt and Evidence

HumanWorkResult
  binds Principal + GraphRevision + immutable content or ArtifactRevision

TargetRevision + ArtifactRevisions + VerificationResults
  form immutable Submission -> DeliveryReview -> Acceptance -> Outcome
```

## 7. 系统不变量

1. 所有业务对象必须属于且只属于一个 Workspace；
2. Target 的目标、约束、验收条件或责任边界变化必须形成新 TargetRevision；
3. 生产 AgentTask Run 必须固定不可变 AgentVersion、Deployment Revision 和 GraphRevision；IntegrationRun 必须固定 Connector/Integration Version、Connection 和 GraphRevision；HumanWorkResult 必须固定 Principal 与 GraphRevision；
4. 已激活 GraphRevision 和已提交 Submission 不得原地修改；
5. Graph Engine 是节点激活与权威状态转换的唯一写入边界，Temporal 只驱动经过领域校验的命令；
6. AgentTask、IntegrationTask、HumanTask 与 GateNode 使用不同完成语义，不得相互伪造；
7. 每个外部 Effect 必须经过结构化 ActionRequest，使用稳定幂等键并形成 EffectReceipt 与 AuditEvent；
8. Invocation、Execution、Decision、Approval 和 Acceptance 授权不得合并；
9. Claim、Evidence、VerificationResult、Submission、Review 和 Acceptance 必须绑定内容或对象 Hash；
10. TargetRevision、Submission 或受验对象变化后，旧 Review 与 Acceptance 不能自动适用；
11. Runner、Adapter、Harness Session、Temporal History 和 Transcript 不是业务事实源；
12. Runner 与 Temporal Worker 不绕过领域服务直接推进 Target、Graph、Review 或 Acceptance；
13. 旧 Lease 的结果不得覆盖使用更高 fencing token 的 Attempt；
14. Secret 明文不得写入 Graph、Workflow History、Run、日志、Artifact、Evidence 或 AuditEvent；
15. 任何 `UnknownEffect` 必须先核验 Provider 状态，不能盲目重放；
16. `accepted` Target 必须可仅从 PostgreSQL 中的版本、Submission、证明、评审和验收事实重建；
17. Timeline、AttentionItem、StageProgress 和 Outcome 是可重建投影，不是独立命令入口；
18. 团队可信记忆只能来自已验收 Submission，并保留来源 Run、Artifact 和 Evidence 引用。
19. Conversation 和 ConversationMessage 不是 Target、Run、Artifact、Evidence、Review、Approval 或 Acceptance 的事实源；所有对话触发的领域变化必须引用独立、可审计的命令或对象。
20. 普通 ConversationMessage 不创建 TargetCreationDraft 或 Target；只有明确创建目标意图才创建 Draft，完整 Draft 必须由具备权限的人类确认后才能幂等转换；
21. Target 必须直接属于一个 Workspace，Collection 关联可以为空；修改或归档 Collection 不得改变已有 TargetRevision 的责任、资源、策略、证据或验收语义。
22. 每个 Workspace 必须解析且只解析一个默认 Agent Deployment；该默认值不产生隐式授权，历史 ConversationMessage、Invocation 和 Run 必须保留实际执行身份。

## 8. 继承实现边界

继承 TypeScript 基座中的对象不自动进入 Verrail 领域。只有下列明确对应关系可以被实现层复用；Project、Case 和 Issue 不能投影或提升为 Target：

| Paperclip 对象 | Verrail 目标语义 |
| --- | --- |
| `company` | Workspace 兼容存储 |
| `project` | 继承实现对象，不属于 Verrail 产品信息架构或 Target 层级 |
| `goal` | Objective 或 Context，不自动等于 Target |
| `pipeline` | ProcessTemplate / StageTemplate，不等于 WorkGraph |
| `case` | 继承实现对象，不自动转换为 Target |
| `issue` | 继承实现对象，不自动转换为 Target 或 WorkNode |
| `heartbeat_run` | Compatibility Service 的继承运行记录，不进入原生 Run 或 TargetReadModel |
| `document` / `document_revision` | Artifact / ArtifactRevision |
| `work_product` | Materialization 或 ExternalRef |
| `decision` | HumanDecision |
| `approval` | ActionApproval，必须补齐参数摘要和失效规则 |
| `activity_log` | Timeline 与 AuditEvent 来源 |
| `agent` / `agent_config_revision` | AgentDefinition 草稿历史，不等于已发布 AgentVersion |

兼容映射必须版本化、可观测、可回滚，并明确终止条件。Verrail 新功能不得继续扩大 CEO、组织图、单指派 Issue 或通用 Board Approval 语义。任何一次迁移都不能同时改变存储、API、权限和 UI 语义而缺少独立验证。
