# Verrail 产品契约

版本：0.1

状态：`Ready_For_User_Review`

最后更新：2026-08-25

审核要求：确认产品对象、标志性旅程、MVP 范围和验收标准

## 1. 产品定位

Verrail 是开源的 Agent 管理与可信交付控制平面。它把 Codex 等成熟 Agent Harness 作为可替换执行运行时，把专业 Agent 作为组织拥有、可版本化、可部署、可评测和可回滚的数字执行者管理。

Verrail 的核心工作不是替 Agent 思考，而是把目标、责任、执行、产物、证据和验收固定在同一条可恢复的交付链上。

```text
AgentDefinition -> AgentVersion -> Deployment -> AgentSession / Run
       -> ArtifactRevision -> Evidence -> DeliveryReview -> Acceptance
       -> EvaluationRun -> ImprovementProposal
```

多人多 Agent 协作由 Human-Agent Work Graph 约束。Director 可以提出计划和重规划建议，Graph Engine 负责节点激活、租约、状态转换、强制门禁和恢复。Agent 的内部计划、Transcript 或自报完成不能替代系统事实。

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

### Project

围绕一个长期交付方向组织 Target、成员、资源、默认策略和时间线。Project 不是权限边界，权限仍由 Workspace Policy 与 ResourceScope 决定。

### Target

具有 Outcome Owner、目标、约束、验收条件、风险等级和截止时间的可交付结果。Target 是用户判断“是否完成”的主要对象。

### Stage

Target 中稳定的交付阶段。默认模板为 Define、Execute、Verify、Accept；团队可在受控范围内配置模板。Stage 聚合 WorkNode、Artifact、Evidence 和 Gate，不取代 Graph 状态。

### Work Graph

Target 的版本化执行计划。GraphRevision 是不可变快照，包含节点、依赖、角色、输入、输出、完成定义、预算和证据要求。

### Artifact / Evidence / Review / Acceptance

Artifact 是交付对象，ArtifactRevision 是不可变版本。Evidence 是来自 Run、CI、扫描器或人工核验的结构化证明。DeliveryReview 汇总特定 Revision 的风险与证明，Acceptance 是具备责任的人对该 Review 的版本绑定决定。

## 5. 节点模型

Work Graph 支持以下一等节点：

| 节点 | 责任主体 | 完成依据 |
| --- | --- | --- |
| `AgentTask` | Agent Deployment | 结构化 RunResult 与要求的 Artifact/Evidence |
| `HumanTask` | Human 或 Group | 结构化提交、附件或决定 |
| `DecisionGate` | Decision Authority | 绑定输入与 GraphRevision 的 HumanDecision |
| `ReviewGate` | Reviewer | 绑定 ArtifactRevision 的 DeliveryReview |
| `AcceptanceGate` | Outcome Owner | 绑定 DeliveryReview 的 Acceptance |
| `IntegrationTask` | CI/CD 或确定性系统 | 可验证 Provider 回执和 Evidence |

Agent 不得完成 HumanTask 或 Gate。人类不得伪造 AgentTask Run。CI 结果不能由 Agent 文本代替。

## 6. 核心旅程

### 6.1 创建并交付 Target

1. Outcome Owner 在 Project 中创建 Target，填写目标、约束、验收条件和风险级别；
2. 系统选择模板或由 Director 提出 GraphProposal；
3. Graph Engine 校验角色、权限、依赖、预算和强制 Gate，生成 GraphRevision；
4. Scheduler 激活就绪节点，AgentTask 通过 Deployment 与 Runner 执行；
5. ArtifactRevision 和 Evidence 持续进入 Target Workbench；
6. 阻塞、未知外部 Effect 或高风险 Action 进入 Attention Inbox；
7. Reviewer 完成 DeliveryReview，Outcome Owner 对固定 Revision 完成 Acceptance；
8. Target 在所有必需节点和验收满足后进入 `accepted`。

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
- `Projects`：Project 与 Target 列表、筛选和状态；
- `Target Workbench`：Overview、Graph、Artifacts、Evidence、Runs、Timeline；
- `Agents`：AgentDefinition、Version、Evaluation、Deployment 和质量趋势；
- `Infrastructure`：RuntimePool、Runner、Sandbox、Connector、Secret 和 Storage；
- `Governance`：Policy、Role、Approval、Audit 和数据策略；
- `Settings`：Workspace、成员、计费、集成与实验能力。

Target Workbench 是标志性界面。它必须让用户不离开 Target 就能回答：目标是什么、谁在负责、卡在哪里、产物是什么、证据是否充分、当前需要我做什么。

## 8. MVP 范围

### 必须具备

- Workspace、Project、Target、Stage 和 Target Workbench；
- AgentDefinition、AgentVersion、Deployment 与基础 EvaluationRun；
- 版本化 GraphRevision 与六类节点；
- Codex Adapter 的固定版本执行与事件归一化；
- ArtifactRevision、Git Diff、Evidence、DeliveryReview 与 Acceptance；
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
- **可靠性**：所有长任务有持久 Run、Attempt、Lease 和幂等键；进程或 Runner 中断不丢失权威状态。
- **可追溯**：生产结果可追溯到 AgentVersion、Deployment Revision、GraphRevision、EnvironmentManifest、Artifact Hash 和责任决定。
- **性能**：核心列表支持分页和服务端筛选；Timeline 增量加载；Run 日志流不阻塞控制操作。
- **可观测**：控制平面、Gateway、Runner、Adapter 和 Sandbox 使用统一 Correlation ID、指标、日志和 Trace 语义。
- **可移植**：开源自托管与 Cloud 使用同一 API、Schema 和 Runner Protocol；第三方服务位于明确 Port 后。
- **可访问**：键盘可操作、焦点清晰、状态不只依赖颜色、文本与控件在支持桌面宽度内不遮挡。
- **国际化**：P0 正式支持英文与简体中文；显式语言选择优先于浏览器检测并在本地持久化；用户内容、技术标识和 Provider 原始诊断默认不自动翻译。

## 10. 成功与验收

MVP 通过以下端到端验收：

1. 用户从 GitHub 需求创建 Target，固定验收条件和 Codex AgentVersion；
2. Agent 在授权工作区生成代码 ArtifactRevision，系统记录环境、日志、成本和权限；
3. 独立 IntegrationTask 对固定 Commit 产生 CI Evidence；
4. Reviewer 能查看 Diff、证据和风险并作出 Review；
5. Outcome Owner 对固定 Review 完成 Acceptance；
6. 产物变化后旧 Review/Acceptance 不再满足门禁；
7. Runner 中断后任务可以恢复或重试，旧 Attempt 不能覆盖新结果；
8. Timeline 可以重建全部关键事实，不依赖 Agent Transcript 作为业务真相；
9. 用户能暂停或回滚 Deployment，并验证后续 Run 使用正确版本；
10. 自托管部署可完成备份、恢复和 Secret Key 联合恢复演练。

## 11. 非目标

- 通用聊天产品、通用项目管理排期和工时系统；
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
