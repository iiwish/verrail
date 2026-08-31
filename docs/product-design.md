# Verrail 产品契约

版本：0.3

状态：`Confirmed`

最后更新：2026-08-28

审核要求：确认产品对象、标志性旅程、MVP 范围和验收标准

## 1. 产品定位

Verrail 是开源的 Agent 管理与可信交付控制平面。它把 Codex 等成熟 Agent Harness 作为可替换执行运行时，把专业 Agent 作为组织拥有、可版本化、可部署、可评测和可回滚的数字执行者管理。

Verrail 的核心工作不是替 Agent 思考，而是把目标、责任、执行、产物、证明和验收固定在同一条可恢复的交付链上。Target 是责任中心，Submission 是评审中心，Evidence 是证明中心，Acceptance 是完成裁决；Graph 和 Agent 都是交付手段。

```text
Target -> TargetRevision -> GraphRevision -> WorkNode
       -> Agent Run / Integration Run / Human Work Result
       -> ArtifactRevision / Evidence -> Submission
       -> DeliveryReview -> Acceptance -> Outcome

AgentDefinition -> AgentVersion -> Deployment -> Run
       -> EvaluationRun -> ImprovementProposal
```

多人多 Agent 协作由 Human-Agent Work Graph 约束。Director 可以提出计划和重规划建议，Graph Engine 负责节点激活、状态转换和强制门禁，Temporal 负责耐久等待、Timer、Retry、Signal、取消与恢复。Agent 的内部计划、Temporal History、Transcript 或自报完成不能替代 PostgreSQL 中的系统事实。

## 2. 目标用户

### Outcome Owner

创建 Target、定义验收条件、选择责任角色并对最终结果负责。需要快速判断是否按目标交付，而不是阅读全部 Agent 日志。

### Delivery Lead

设计 Stage 和 Work Graph，处理阻塞、改派、风险与跨角色协调。需要看到关键路径、当前责任与下一步行动。

### Reviewer / Approver

根据 Artifact、Diff、Evidence 和风险作出评审、行动批准或验收决定。需要明确自己在决定什么，以及决定绑定的版本。

### Agent Builder

定义 Agent、固定模型与 Skill、运行评测、发布 Deployment 并观察跨运行质量。需要比较版本，而不是维护不可追溯的 Prompt 文件。

### Platform / Security Operator

管理身份、Secret、Connector、Runner、Sandbox、策略、成本、审计和数据驻留。需要默认拒绝、最小权限和可恢复运行。

## 3. 用户待办任务

1. 把一个模糊需求转成带验收条件和责任人的 Target；
2. 选择已发布 Agent，而不是临时拼装无法复现的会话；
3. 让 Agent、人类和 CI 按一个可恢复执行图协作；
4. 在一个工作台中查看产物、差异、证据、风险与历史；
5. 只在真正需要人类责任时收到清晰的 Attention 项；
6. 在本地、托管沙箱或客户网络执行，同时保持同一治理语义；
7. 根据评测和生产证据升级或回滚 AgentVersion。

## 4. 核心产品对象

### Workspace

租户级安全与数据边界，拥有身份、策略、Project、Agent、Connector、RuntimePool 和审计记录。当前继承实现中的 `company` 可以作为过渡存储边界，但产品界面统一使用 Workspace。

Workspace 采用环境化租户体验。首次进入时，部署后端为用户或单租户实例幂等提供一个默认 Workspace；仅有一个可访问 Workspace 时，日常工作台不展示切换器，也不要求用户先理解租户结构。拥有多个 Workspace 时才展示切换入口。隐藏切换器不改变 Workspace 的权限、隔离、审计、计费和 URL 兼容边界。

### Conversation

Conversation 是用户与 Verrail 协作的持久交互上下文，属于一个 Workspace，并可绑定 Project、Target、Stage、ArtifactRevision 或其他可审阅对象。Conversation 与 Message 保存对话连续性、用户意图和系统回复，但不拥有 Target、Run、Artifact、Evidence、Review、Approval 或 Acceptance 的业务真相。

对话提出的执行、修改、外部 Effect、批准和验收必须转化为相应的版本化领域命令或对象，并在界面中显示可检查的目标、参数、权限、状态和结果引用。聊天文本本身不能直接推进 Target、伪造 Evidence、批准 ActionRequest 或替代 Acceptance。

### Project

围绕一个长期交付方向组织 Target、成员、资源、默认策略和时间线。Project 不是权限边界，权限仍由 Workspace Policy 与 ResourceScope 决定。

Project、Target 与 Work 的规范所有权关系固定为 `Project -> Target -> WorkGraph -> WorkNode`。Project 回答交付属于哪个长期业务空间；Target 固定一次可验收结果及责任边界；WorkNode 表达为达成该 Target 需要完成的执行或门禁。Project 可以聚合展示其全部 Target 的 Work，但聚合视图不改变 WorkNode 的 TargetRevision 和 GraphRevision 归属。

继承实现中的 Project-scoped Issue 是迁移期兼容工作，不构成 `Project -> Task` 领域关系。没有经过显式映射的 Issue 不自动成为 Target，也不由 UI 猜测 Target 归属；新交付工作只在 Target Workbench 的 Work 上下文创建。原生 WorkNode 可用前，兼容 Issue 继续通过明确标注的 Legacy Work 表面操作。

### Target / TargetRevision

Target 是可交付结果的稳定身份，也是用户判断“是否完成”的主要对象。TargetRevision 是不可变责任合同，固定 Outcome Owner、目标、约束、验收条件、风险等级、截止时间和适用策略。条件或责任边界变化必须形成新 Revision，旧证据与验收不能静默沿用。

### Stage

Target 中稳定的交付阶段和导航投影。默认模板为 Define、Execute、Verify、Accept；团队可在受控范围内配置 StageTemplate。StageProgress 聚合 Graph、Work、Submission 和 Gate 状态，但 Stage 不拥有 Artifact、Evidence，也不取代 Graph 状态。

### Work Graph

TargetRevision 的版本化执行计划。GraphRevision 是不可变快照，包含节点、依赖、角色、输入、输出、完成定义、预算和证据要求。Graph 是高级检查和故障处理表面，普通用户优先看到 Stage、当前责任和下一步行动。

### Criterion / Claim / Evidence / Verification

AcceptanceCriterion 属于 TargetRevision，定义可判定要求和允许的证明方式。Submission 针对 Criterion 提出 Claim；Evidence 是来自 Run、CI、扫描器、Provider 或人工核验的不可变证明；VerificationResult 记录特定验证器对 Claim 和 Evidence 的 `passed`、`failed`、`inconclusive` 或有权 `waived` 结论。

### Artifact / Submission / Review / Acceptance

Artifact 是稳定交付对象，ArtifactRevision 是内容寻址的不可变版本。Submission 是一次不可变的交付候选，固定 TargetRevision、ArtifactRevision、VerificationResult、Commit/外部对象和环境摘要。DeliveryReview 评审 Submission，Acceptance 是具备责任的人对该 Review 和 Submission 的版本绑定决定。

### 产品对象可见性

日常工作台优先使用 Target、Stage、Work、Run、Artifact、Evidence、Review 和 Agent 八个概念。UI 中的 Runs 视图聚合 Agent Run 与 IntegrationRun，但必须显示执行主体类型；HumanWorkResult 留在对应 Work 中。TargetRevision、GraphRevision、RunAttempt、IntegrationAttempt、Lease、Grant、EnvironmentManifest 和 Temporal Workflow 属于需要时展开的高级信息，不要求普通用户先理解内部本体才能完成交付。

## 5. 节点模型

Work Graph 支持 TaskNode 与 GateNode 两类节点：

| 类别 | 节点 | 责任主体 | 完成依据 |
| --- | --- | --- | --- |
| Task | `AgentTask` | Agent Deployment | Run/RunAttempt、结构化 RunResult 与要求的 Artifact/Evidence |
| Task | `HumanTask` | Human 或 Group | 不可变 HumanWorkResult、结构化提交或附件 |
| Task | `IntegrationTask` | CI/CD 或确定性系统 | IntegrationRun、Provider 回执和 Evidence |
| Gate | `DecisionGate` | Decision Authority | 绑定输入、TargetRevision 与 GraphRevision 的 HumanDecision |
| Gate | `ReviewGate` | Reviewer | 绑定 Submission 的 DeliveryReview |
| Gate | `AcceptanceGate` | Outcome Owner | 绑定 DeliveryReview、Submission 与 TargetRevision 的 Acceptance |
| Gate | `PolicyGate` | Policy Engine | 可解释、版本化的 PolicyResult |

AgentTask 产生 Run/RunAttempt，IntegrationTask 产生 IntegrationRun/IntegrationAttempt，HumanTask 产生 HumanWorkResult；GateNode 等待并校验领域事实，不创建伪执行。四种完成语义不得互相伪造，CI 结果不能由 Agent 文本代替。

## 6. 核心旅程

### 6.1 创建并交付 Target

1. Outcome Owner 在 Project 中创建 Target，发布固定目标、约束、验收条件和风险级别的 TargetRevision；
2. 系统选择 ProcessTemplate，或由 Director 针对该 TargetRevision 提出 GraphProposal；
3. Graph Engine 校验角色、权限、依赖、预算和强制 Gate，生成 GraphRevision；
4. Temporal TargetWorkflow 耐久协调节点、等待、Timer、Retry、Signal 和取消，Graph Engine 裁决节点是否可激活；
5. 就绪 AgentTask 产生 Run/RunAttempt，IntegrationTask 产生 IntegrationRun/IntegrationAttempt，HumanTask 等待有权主体提交 HumanWorkResult；
6. ArtifactRevision、Claim、Evidence 和 VerificationResult 持续进入 Target Workbench；
7. 责任主体创建固定 TargetRevision、Artifact、证明、Commit 和环境摘要的 Submission；
8. 阻塞、未知外部 Effect、高风险 Action、证明缺口或待验收项进入 Attention Inbox；
9. Reviewer 对 Submission 完成 DeliveryReview，Outcome Owner 对同一 Submission 完成 Acceptance；
10. Target 在全部必需节点、Criterion 和 Acceptance 满足后派生为 `accepted`。

### 6.2 发布 AgentVersion

1. Agent Builder 编辑 AgentDefinition；
2. 发布不可变 AgentVersion，固定 Runtime、模型、Prompt、Skill、工具、输出 Schema 和 Capability 上限；
3. EvaluationRun 与基线比较质量、成本、延迟和安全结果；
4. 通过门禁后创建或更新 Deployment；
5. 生产 Run 固定 Deployment Revision；
6. 回归时暂停或回滚 Deployment，历史 Run 保持可追溯。

### 6.3 企业私有执行

1. Operator 创建 Private RuntimePool 并生成一次性 Runner Enrollment；
2. 客户网络中的 Runner 主动连接 Execution Gateway；
3. Runner 上报能力、容量、隔离等级、区域和数据策略；
4. Scheduler 只向满足 RequiredRuntimeCapabilities 的 Runner 发放 Lease；
5. Workspace、代码和运行时 Secret 按 DataEgressPolicy 留在客户网络；
6. Runner 只回传允许的状态、摘要、Hash、Evidence 和 Artifact；
7. 失联后租约过期，新 Attempt 使用 fencing token 防止旧结果覆盖。

## 7. 信息架构

正式工作台以桌面端、高信息密度和重复操作效率为目标。

- `Home`：跨 Project 的 Attention、风险、运行健康和最近交付；
- `Chat`：持久会话、上下文绑定和面向领域对象的自然语言协作入口；
- `Projects`：Project 与 Target 列表、筛选和状态；
- `Target Workbench`：Overview、Stages、Work、Submission、Artifacts、Evidence、Runs、Timeline；Graph 作为高级视图；
- `Agents`：AgentDefinition、Version、Evaluation、Deployment 和质量趋势；
- `Infrastructure`：RuntimePool、Runner、Sandbox、Connector、Secret 和 Storage；
- `Governance`：Policy、Role、Approval、Audit 和数据策略；
- `Settings`：Workspace、成员、计费、集成与实验能力。

Target Workbench 是标志性界面。它必须让用户不离开 Target 就能回答：目标是什么、谁在负责、卡在哪里、产物是什么、证据是否充分、当前需要我做什么。

Home 与 Chat 分工明确：Home 回答“什么需要我”，Chat 回答“我要让系统做什么”。Chat 是一级工作入口，不取代 Target Workbench；进入绑定 Target、Artifact 或 Review 的长工作流时，界面保持对应工作对象可见，并把 Agent Run、建议、Diff、Evidence 和决定渲染为可检查对象，而不是普通聊天气泡。

## 8. MVP 范围

### 必须具备

- Workspace、Project、Target、TargetRevision、Stage 和 Target Workbench；
- Workspace 默认供给、单 Workspace 环境化体验、持久 Conversation 与基础会话管理；
- AgentDefinition、AgentVersion、Deployment 与基础 EvaluationRun；
- 版本化 GraphRevision、TaskNode/GateNode 与 Temporal 耐久编排；
- Codex Adapter 的固定版本执行与事件归一化；
- AcceptanceCriterion、Claim、ArtifactRevision、Git Diff、Evidence、VerificationResult、Submission、DeliveryReview 与 Acceptance；
- GitHub 需求和 Pull Request 的 Connector 闭环；
- HostTrusted Runner、工作区范围、Lease、恢复和审计；
- 本地或自托管 PostgreSQL、对象存储、Secret 和基础身份；
- 真实错误、空状态、加载状态、取消、重试和人工拒绝路径。

### 后续能力

- CubeSandbox 强隔离生产准入；
- Private Runner、SSO、SCIM、数据驻留和审计导出；
- 多 Adapter 完整一致性、灰度发布和自动回滚；
- 企业 Channel、更多 SCM/CI/CD 与专业产物 Connector；
- 托管 Cloud 的 Fleet、Quota、Region、Billing 与 Tenant Cell。

## 9. 非功能需求

- **安全**：默认拒绝；Secret 引用化；高风险 Action 参数绑定审批；租户、资源和运行时作用域强制检查。
- **可靠性**：AgentTask 具有持久 Run、RunAttempt、Lease 和幂等键；IntegrationTask 具有持久 IntegrationRun、IntegrationAttempt、Provider Receipt 和幂等键；HumanTask 具有不可变 HumanWorkResult；长流程由 Temporal Workflow 恢复。API、Worker、Temporal、Runner、Harness 或 Provider 中断不丢失业务事实，Workflow replay 不重复外部 Effect。
- **可追溯**：生产结果可追溯到 TargetRevision、Submission、AgentVersion、Deployment Revision、GraphRevision、EnvironmentManifest、Artifact Hash、VerificationResult 和责任决定。
- **性能**：核心列表支持分页和服务端筛选；Timeline 增量加载；Run 日志流不阻塞控制操作。
- **可观测**：控制平面、Gateway、Runner、Adapter 和 Sandbox 使用统一 Correlation ID、指标、日志和 Trace 语义。
- **可移植**：开源自托管与 Cloud 使用同一 API、Schema 和 Runner Protocol；第三方服务位于明确 Port 后。
- **可访问**：键盘可操作、焦点清晰、状态不只依赖颜色、文本与控件在支持桌面宽度内不遮挡。
- **国际化**：P0 正式支持英文与简体中文；显式语言选择优先于浏览器检测并在本地持久化；用户内容、技术标识和 Provider 原始诊断默认不自动翻译。

## 10. 成功与验收

MVP 通过以下端到端验收：

1. 用户从 GitHub 需求创建 TargetRevision，固定验收条件和 Codex AgentVersion；
2. Agent 在授权工作区生成代码 ArtifactRevision，系统记录环境、日志、成本和权限；
3. 独立 IntegrationTask 对固定 Commit 和 Criterion 产生 CI Evidence 与 VerificationResult；
4. 系统创建固定 TargetRevision、ArtifactRevision、VerificationResult 和环境摘要的 Submission；
5. Reviewer 能查看 Diff、证明覆盖、缺口和风险并对 Submission 作出 Review；
6. Outcome Owner 对固定 Review 与 Submission 完成 Acceptance；
7. TargetRevision、Submission 或受验内容变化后旧 Review/Acceptance 不再满足门禁；
8. API、Temporal Worker 或 Runner 中断后任务可以恢复或重试，旧 Attempt 不能覆盖新结果，外部 Effect 不重复；
9. Timeline 可以从 PostgreSQL 事实重建，不依赖 Temporal History 或 Agent Transcript 作为业务真相；
10. 用户能暂停或回滚 Deployment，并验证后续 Run 使用正确版本；
11. 自托管部署可完成 PostgreSQL、对象存储、Temporal Namespace 和 Secret Key 的联合恢复演练。

## 11. 非目标

- 脱离 Project、Target、Artifact、Run 和治理对象的通用聊天产品，以及通用项目管理排期和工时系统；
- AI 公司 CEO、组织图和雇员隐喻；
- 通用 Agent Loop、IDE、代码托管或专业文档编辑器；
- 任意 DAG/低代码工作流设计器；
- 用自然语言批准未绑定参数的外部 Effect；
- 把 Harness Session、Channel 消息或 Runner 本地数据库作为权威事实。

## 12. 开放问题

- MVP 是否只正式支持 Codex，还是要求第二个 Adapter 同步达到完整合同；
- 默认 Stage 模板是否允许 Workspace 管理员编辑；
- Acceptance 默认由单一 Outcome Owner 还是角色组法定人数完成；
- Artifact 大文件和敏感内容在 Cloud/Private Runner 之间的默认出站策略；
- Target 与现有 Project/Issue 表的兼容期长度和迁移终止条件。
