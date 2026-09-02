# Verrail 项目章程

版本：1.2
状态：`Confirmed`

最后更新：2026-09-01
审核要求：产品、架构、实现与验收必须遵守本章程

## 1. 目的

Verrail 是开源的 Agent 管理与可信交付控制平面。平台把专业 Agent 作为组织拥有的长期数字执行者，管理其
定义、版本、部署、运行、评测、改进和退役；Codex、OpenCode 及后续 Harness 是可替换执行运行时，不是
Agent 身份、权限或交付事实源。个人或企业通过 Web、API、Schedule 及 Channel/Provider Event 启动工作；
每个 Target 的单一活动 Director 负责理解目标、提出包含多个专业 Agent 与多个人类角色的动态异构执行图，Graph
Engine 负责校验、角色解析、调度、恢复和记录权威状态。平台必须让多个 Agent 与多个人类按节点责任协作，
同时不把组织责任、凭证或高风险决策交给无法承担责任的自动化主体。

## 2. 不可协商原则

### P-001：交互入口不是真相源

钉钉、飞书、企微、REST API、Webhook、Schedule 和 A2A 都是调用、协作或通知入口。
Channel 消息、Agent Transcript、Temporal History 和 Harness Session 都不是业务真相源。
Verrail 中持久化的 Conversation、TargetCreationDraft、Target、TargetRevision、GraphRevision、WorkNode、Invocation、Run、RunAttempt、IntegrationRun、IntegrationAttempt、HumanWorkResult、
ActionRequest、ArtifactRevision、Evidence、VerificationResult、Submission、HumanDecision、ActionApproval、
DeliveryReview、Acceptance、Outcome 和 AuditEvent 才是系统记录。

### P-002：Agent 生命周期必须版本化管理

AgentDefinition 是可编辑设计容器，AgentVersion 是不可变发布快照，Deployment 是唯一生产身份。
草稿 AgentDefinition 和 Harness 私有 Agent/Session 不能直接接收生产调用。创建、评测、发布、部署、暂停、
升级、回滚、改进和退役必须形成可审计状态转换；每次 AgentTask Run 必须能够追溯到准确版本、配置、权限、Runtime、
Harness、Skill 与插件版本。

### P-003：每类执行都形成可恢复的持久事实

群聊、API、事件和定时调用必须归一为 Invocation。AgentTask 使用持久化 Run/RunAttempt，IntegrationTask 使用
IntegrationRun/IntegrationAttempt，HumanTask 使用不可变 HumanWorkResult；不同执行事实不得相互伪造。
Temporal Workflow 负责耐久等待、Timer、Retry、Signal、取消和恢复；浏览器、聊天连接、API、Temporal Worker、
Runner 或单次模型会话中断不得导致业务事实丢失。

### P-004：默认拒绝且不可自我扩权

Agent 只拥有显式 Grant 授予的 Capability。权限必须限定主体、操作、资源和条件。Agent
不得修改自己的版本、权限或凭证，不得批准自己发起的高风险操作，也不得把更大的权限
委派给子 Agent。

### P-005：外部影响必须经过结构化 Action

代码推送、Pull Request、CI/CD、通知和平台内部操作必须经过 Capability Gateway，以
结构化 Action 执行。不得把长期凭证直接注入 Agent Shell，也不得把自然语言工具调用
当作授权依据。

### P-006：人类决定、行动授权与验收必须分离

HumanDecision 只推进绑定 GateNode，ActionApproval 只决定一个 ActionRequest 是否可以发生，Acceptance 只决定一个
Submission 的 DeliveryReview 是否被接受。三者分别使用 DecisionAuthority、ApprovalAuthority 和 AcceptanceAuthority，
并绑定 TargetRevision、GraphRevision、输入摘要、Action 参数、Submission、Artifact 摘要、Commit SHA 或内容 Hash。相关对象改变后，
旧决定不得自动适用于新对象，也不得用一种决定替代另一种。

### P-007：多 Agent 协作由执行图约束

人类通过 Target Timeline 及其 Channel/Web 投影协作；Agent 不感知 Channel Provider、Thread、卡片或历史
分页。每个 Target 同一时刻只有一个活动 Director RoleSlot；Director 可以响应归一化的 Trigger、API
或 @Director Invocation 来提出计划，但不是唯一执行者。同一 Graph 可以包含多个 Specialist AgentRoleSlot 和多个
HumanRoleSlot：专业 Agent 只有在 Graph Engine 激活并指派对应 AgentTask 后才能执行，Human/Group 只在对应
HumanTask 或 Gate 激活时承担执行、决策、评审或验收责任。对专业 Agent 的 @ 只作为节点输入或改派建议，
不创建 Graph 外执行。Agent 之间的工作交接必须通过带目标、输入、完成定义、预算、
截止时间、证据要求和子权限的 WorkNode 或 Delegation；不得把自由群聊当作调度协议。子 Agent
权限只能缩小，不能通过调用链或 GraphRevision 放大。

### P-008：提供方能力必须插件化，治理内核不得插件化

GitHub、GitLab、CI、企业聊天、Runtime 和 Secret Provider 通过插件接入。身份、授权、
Run 状态、审批、审计、幂等、预算和委派规则属于 Verrail 内核，不允许插件绕过。

### P-009：复用成熟 Agent Harness

Verrail 不自研通用 Agent Loop。Coding、Research 或其他 Agent 能力通过版本化 AgentRuntimeAdapter
接入成熟 Harness。Verrail 负责部署、权限、调度、证据、恢复与验收，Harness 负责模型循环、上下文
处理和本地工具协作。Harness 不得成为权限、Run 状态或审计的权威来源。

### P-010：为分布式执行保留边界，不提前制造复杂度

控制平面与执行平面从第一版开始使用明确协议。MVP 采用模块化 Server，并允许一个控制平面纳管
一个或多个 Headless Runner，但不得依赖 Runner 本地数据或进程内状态作为恢复依据。Kubernetes、多区域和
断网执行不进入 MVP。

### P-011：Channel 是人类投影，AgentSession 是上下文边界

普通用户通过 Target Timeline 的 ChannelProjection 或 Web 投影协作，并在本地专业应用或 GitHub、GitLab、
CI/CD、文档与设计平台中深度编辑和查看产物。Verrail 仍是产物合同、生产来源、责任、证据与验收关系的
权威记录。一个 Channel 可以承载多个 Target 投影，一个 Target 可以产生
多个按角色隔离的 AgentSession。新 AgentSession 通过带来源引用的 ContextSnapshot 接续历史，不默认重放
全部 Channel 或 Transcript。Agent 不管理 Channel；Channel 消息顺序不能隐式推进流程。Verrail Web 端提供
Attention Inbox、Chat、Target、Graph、Artifact 与 Evidence 工作台。Collection 是可选聚合表面，不是进入 Target 的必经层级。
Verrail 不建设通用项目管理排期与工时看板，也不做脱离 Target、Graph 和 Artifact 的通用闲聊框。

### P-012：团队知识与经验必须经过人类验收门禁

沙箱中的任务工作记忆随 Run 销毁，严禁未经验证的中间思考外溢为全局事实。跨任务的团队工程经验与反思沉淀必须绑定来源 Run，且仅在对应 `DeliveryReview` 获得具备权限的人类 `Acceptance` 验收后，才允许进入可信记忆库（`AcceptedTrusted`），从源头杜绝错误代码与幻觉污染全局。

### P-013：Director 负责规划，Graph Engine 负责裁决

Director 是可版本化、可替换、受权限约束的普通 Agent Deployment，只能提交 GraphProposal/ReplanProposal、
ReviewRecommendation、推荐角色、请求重规划和汇总状态。是否建议人类评审由 Director AgentVersion 的
Prompt、Output Schema 和评测合同决定；Workspace Policy 可以增加强制评审但不能被 Agent 绕过。Graph
Engine 是节点激活、ReviewGate、状态转换、强制门禁和并发策略的唯一业务写入边界。Temporal 负责耐久编排，
但只能驱动经过 Graph Engine 和领域服务校验的命令，不能自行裁决业务状态。
Director 不得直接修改权威 Graph 状态、删除 Policy 注入的节点或批准自身 Action；交付类 AgentTask 必须指派给
非 Director 专业 Agent Deployment。

### P-014：人类与确定性集成是一等节点

HumanTask、AgentTask 和 CI/CD IntegrationTask 是 TaskNode，必须具有明确输入、责任角色、输出、完成条件、
截止时间和审计记录。AgentTask 形成 Run/RunAttempt，IntegrationTask 形成 IntegrationRun/IntegrationAttempt，
HumanTask 形成 HumanWorkResult。DecisionGate、ReviewGate、AcceptanceGate 和 PolicyGate 是 GateNode，只能由对应的
版本绑定决定、评审、验收或策略结果满足，不创建伪 Run。Agent 自报的测试或部署结果不能
替代 CI/CD Provider 回传的 Evidence；Agent 不得完成 HumanTask/Gate，人类不得伪造 AgentTask Run；任何生产部署仍受
Capability、Policy 和 Approval 约束。

### P-015：Verrail 生产产物，专业平台承载产物

Verrail 负责定义产物合同、组织 Agent 与 Human 生产专业产物、记录版本与来源，并推动评审和验收。代码、
文档、原型、报告等产物可以先在受管理 Workspace 中形成，再通过 Connector Plugin 物化到 GitHub、飞书、
钉钉、Figma 或其他专业平台。专业平台负责深度编辑、查看和原生协作体验；Verrail 负责 Artifact、
ArtifactRevision、Materialization、Evidence、责任决定和 Acceptance 的事实关系。

MVP 不因缺少具体 Connector 而取消产物生产。系统使用本地 Workspace、内容寻址快照和用户登记的外部引用完成
产物闭环，并定义稳定 Connector Plugin 合同。Verrail 提供绑定不可变 ArtifactRevision 的 Review-grade
Artifact Preview、Revision Diff、评论、Evidence 检查和验收操作，不建设专业编辑器、格式特有创作能力或
外部平台原生协作界面。Preview 是可重建投影，Submission 固定 TargetRevision、ArtifactRevision、
VerificationResult 与环境摘要，DeliveryReview 与 Acceptance 必须绑定同一 Submission 和内容 Hash。
深度编辑通过 Runner Workspace 或专业平台完成；外部修改必须经 Hash 检测和授权导入形成新 ArtifactRevision，不能覆盖
已评审或已验收版本；旧 Review 与 Acceptance 保持不可变，并对新 Revision 明确标记为不适用。

### P-016：Web-first、PostgreSQL 权威事实与 Headless Runner

Web 控制台和公共 API 是一等控制表面。PostgreSQL 是所有部署的唯一权威关系事实库，不提供 SQLite
产品路径，不同步两个可变数据库。需要本地 CLI、代码或内网能力时，必须通过可认证、可吊销、
主动出站连接的 Headless Runner 执行；浏览器不能凭端口可达性或本机账户隐式获得 CLI 权限。
官方托管与开源自托管使用同一领域、API、Schema 和 Runner Protocol，Kubernetes 只能作为可选部署/执行
Backend，不能成为 Verrail 领域真相源。

### P-017：Temporal 是耐久编排内核，不是业务数据库

Target 和 Run 的长生命周期编排必须使用 Temporal Workflow，禁止继续扩展基于进程内 Timer、周期扫描和手工恢复器的
新主流程。PostgreSQL 仍是产品查询、权限、版本、证据、评审、验收和审计的唯一权威事实库。Temporal Event History
只恢复编排决策；所有数据库写入、Provider 调用、LLM 调用和文件操作通过幂等 Activity 或受治理的执行协议完成。
PostgreSQL 与 Temporal 之间通过 Transactional Outbox、稳定 Workflow ID 和幂等命令收敛，不宣称跨系统 exactly-once。

### P-018：会话不自动创建目标，Collection 不阻塞目标成立

一个企业 Provider 群聊或私聊在一个 Workspace 中映射为一个持久 Conversation。普通消息、@Agent、Agent 建议和一次性调用都不能自动创建 Target。只有用户明确要求创建目标时，系统才创建绑定来源 Conversation、Message 和发起人的 TargetCreationDraft；Agent 通过后续多轮消息补齐目标、责任人、验收条件、风险、资源和策略上下文，并向用户展示版本化确认摘要。

完整 Draft 必须由具备 InvocationAuthority 和 Target 创建权限的人类明确确认，随后才可通过幂等领域命令创建 Target 与首个 TargetRevision。Agent 不得代表人类确认，初始消息即使字段完整也不得静默创建。Target 直接属于 Workspace；Collection 只作为可选归类和视图，不是权限边界、创建前置或可变策略真相源。详细合同见 [`conversation-target-creation.md`](./conversation-target-creation.md)。

## 3. 质量与架构原则

- 核心状态转换必须可测试、可重放或可解释。
- 动态计划必须版本化；GraphRevision 的 ReviewRecommendation、Policy 校验、评审或自动激活依据必须可追溯。
- 可复用流程通过人类发布的 GraphTemplateVersion 固化必需角色、门禁和证据合同；Director 只能在其边界内
  动态实例化和重规划。
- AgentSession 与 Channel 解耦；ContextSnapshot 的来源、生成版本、覆盖范围、权限过滤和内容 Hash 必须可追溯。
- Provider 特有概念只能出现在插件适配层；内核使用中立 Capability 和 ResourceRef。
- 所有产生外部影响的重试必须使用幂等键，或明确标记为不可自动重试。
- PreviewRenderer 必须固定版本、隔离主动内容并显式展示截断、失败与外部 fallback，不得把不完整预览作为完整证据。
- Run Timeline 以结构化事件为主，原始 Transcript 仅用于诊断。
- `NoChange` 等无实质变化 Outcome 必须保留审计记录，但在用户注意力界面中聚合展示。
- 优先完成一个可信端到端闭环，不以 Agent 数量、插件数量或界面数量衡量完成度。

## 4. 安全、隐私与合规原则

- Human、Group、ServiceAccount、Deployment、PluginInstallation 和 Runner 使用独立身份。
- AgentVersion 声明能力上限但不持有可变生产授权，实际执行权限绑定 Deployment。
- Secret 只通过短期 CredentialLease 提供给受信执行组件，Agent 只能引用，不能读取原值。
- 所有资源标识必须包含 Workspace 边界，跨租户访问默认拒绝。
- 审计事件追加写入并具有防篡改校验，不允许 Agent 修改或删除。
- 支持日志脱敏、数据保留策略、凭证轮换、紧急吊销和全局 Kill Switch。
- Web 会话、ServiceAccount、Deployment、PluginInstallation 和 Runner 必须分别认证；端口可达性、
  宿主账户或 Harness 登录状态不构成 Verrail 授权。

## 5. UX 与可访问性原则

- 管理控制台面向 1280 CSS px 及以上桌面视口，并保证常见较窄桌面窗口可用。
- 日常界面围绕 Attention Inbox、Chat、Target、Stage、Graph、Artifact、Evidence 和 Outcome 组织；Collection 只作为可选筛选和聚合；Agent、
  Deployment、Integration、Runtime 和 Access 属于管理表面。
- Artifact Review 必须支持文档和代码产物的安全预览、Base/Head Revision 对比、Git Diff、评论、Evidence、
  外部打开与验收，并持续显示绑定的 Revision、Hash、Renderer 状态和截断范围。
- 高风险操作必须展示影响范围、授权依据和不执行的默认结果。
- 状态不能只靠颜色表达；键盘操作、焦点状态和语义化标签属于基础质量要求。
- 不用主观进度百分比替代可观察的 Run、Action、Artifact 与 Evidence 状态。

## 6. Git 与审核策略

- 实施任务必须从已定义的纵向闭环和合同边界拆分，不得绕过 SSOT 扩大范围。
- 行为、数据、安全和权限修改必须包含测试与真实验证证据。
- 实施不得覆盖无关用户改动，不得用占位结果或未运行测试宣称完成。
- Agent 生成的代码必须经过独立 review；高风险 Effect 必须经过具备权限的人类批准。

## 7. 变更流程

影响不可协商原则的修改必须单独更新本章程并由用户明确确认。产品范围变化更新
`product-design.md`；语义变化更新 `operational-ontology.md`；实现边界变化更新
`architecture.md`。同一决策涉及多份文档时必须保持交叉引用一致。

## 8. 例外

例外必须记录适用范围、责任人、原因、到期时间和补偿控制。任何例外都不能允许 Agent
自我扩权、伪造审批、绕过审计或把长期生产凭证暴露给非受信执行环境。
