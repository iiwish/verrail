# Verrail 导航与路由迁移合同

版本：0.4

状态：`Confirmed`

最后更新：2026-08-28

变更要求：一级信息架构、Canonical Route、路由身份、权限或兼容窗口发生变化时重新评审本合同

## 1. 目标

Verrail 导航围绕可信交付组织，而不是围绕继承的 AI 公司、Issue Tracker 和后台功能清单组织。用户进入产品后首先看到需要关注的 Target、风险、运行和决定，并能在不理解内部 Graph、Temporal 或 Runner 术语的情况下完成交付。

导航只表达用户稳定心智；实验功能、Provider、Plugin 和兼容页面通过二级导航、设置、搜索、命令面板或深链访问，不竞争主导航位置。

## 2. Workspace 路由边界

G1 继续使用现有 `/:workspacePrefix/*` URL 形态和 Workspace 前缀值，避免破坏收藏、分享和跨 Workspace 跳转。实现中的 `companyPrefix` 可以作为兼容变量名保留，不定义产品术语。

以下路由均省略 `/:workspacePrefix` 前缀书写。公共 Auth、Invite、Onboarding、CLI Auth 和实例级设置继续使用现有全局路由边界。

## 3. 一级信息架构

主导航固定为：

| 顺序 | 表面 | 责任 | Canonical Route |
| ---: | --- | --- | --- |
| 1 | Home | My Targets、Attention、风险、活动 Run 和最近交付 | `/home` |
| 2 | Chat | 持久会话、上下文绑定、查询与受控操作入口 | `/chat` |
| 3 | Projects | Project 与 Target 列表、筛选、状态和创建 | `/projects` |
| 4 | Agents | AgentDefinition、Version、Evaluation 和 Deployment | `/agents` |
| 5 | Infrastructure | Runner、Runtime、Connector、Secret、Storage 和环境 | `/infrastructure` |
| 6 | Governance | Attention、Policy、Approval、Audit、Cost 和数据策略 | `/governance` |
| 7 | Settings | Workspace、成员、角色、集成、计费和实验配置 | `/settings` |

Search 与 Command Palette 是全局命令，不作为领域栏目。创建主命令是 `New Target`；`New Task` 只在 Target Workbench 的 Work 上下文或兼容页面出现。

Organization/Org Chart、Goals、Routines、Pipelines、Cases、Skills 和 Apps 不进入默认一级导航。它们按目标语义进入 Target、Agents、Infrastructure、Settings、二级 Advanced 区域或兼容深链。

## 4. Home

Home 是操作型收件箱，不是图表 Dashboard。默认按以下优先级展示：

1. 需要当前用户 Decision、Approval、Review 或 Acceptance 的 Attention；
2. 失败、阻塞、失联或等待输入的 Target 和 Run；
3. 分配给当前用户的活动 Target；
4. 最近发生实质变化的 Target 和 Submission；
5. 运行容量或策略异常。

Home 支持 Project、Role、Stage、Status 和 Owner 筛选。没有真实数据时展示可执行空状态，不展示演示图表或营销说明。

## 5. Chat

Chat 是紧随 Home 的一级工作入口。`/chat` 展示新会话入口和最近会话，`/chat/:conversationId` 展示持久线程。上下文侧栏提供 New chat、Search、Pinned、Recent 和 Archived；基础管理包含创建、自动命名、重命名、置顶、搜索、归档和恢复，不以硬删除作为默认操作。

Conversation 属于当前 Workspace，并可显式绑定 Project、Target、Stage 或 ArtifactRevision。对话回复中的 Target、Run、ActionRequest、Approval、Artifact、Evidence、Review 和 Acceptance 必须作为可跳转、可检查的领域引用呈现。聊天记录不构成 Target 完成、Evidence、外部 Effect 批准或 Acceptance。

## 6. Project 与 Target 路由

Project 的规范产品层级是 `Project -> Target -> Work`。Project 导航以 Overview 和 Targets 为主；Work 只在 Target Workbench 内作为正式执行表面。Project 可以提供跨 Target 的只读工作聚合，但必须按 Target 分组且创建 Work 时要求确定 Target。继承的 Project-scoped Issue 保留在 Legacy Work 兼容表面，不与 Targets 并列表达新的领域所有权。

Projects 使用领域层级型上下文二级侧栏。侧栏提供全部项目入口、当前 Principal 可见的 Project 列表和创建操作；选中 Project 在原位展开当前 Principal 可见的 Target 列表，而不是展开 Project 功能菜单。进入 Target Workbench 后保持同一 Projects 侧栏、所属 Project 和选中 Target，使 `Project -> Target` 关系持续可见。

Project 行进入独立 Project Detail。Overview、Resources、Plugin 能力、Settings、Budget 与 Legacy Work 属于 Project Detail 内部导航，不占用对象层级侧栏；Project Targets 页面提供筛选、创建和批量查看，侧栏负责在 Project 与 Target 之间快速切换。Target 和 Legacy Work 不作为 Project 的同级对象展示。

| 对象 | Canonical Route | 主要表面 |
| --- | --- | --- |
| Project 列表 | `/projects` | Project、活动 Target、健康和最近活动 |
| Project 概览 | `/projects/:projectId` | Overview、Targets、Resources、Members、Configuration |
| Project Targets | `/projects/:projectId/targets` | 目标列表、筛选、创建和批量查看 |
| Project Legacy Work | `/projects/:projectId/legacy-work` | 继承的 Project-scoped Issue 兼容操作；不推断 Target 归属 |
| Target Workbench | `/targets/:targetId` | 默认跳转 Overview |
| Target Tab | `/targets/:targetId/:tab` | `overview`、`stages`、`work`、`submission`、`artifacts`、`evidence`、`runs`、`timeline` |
| TargetRevision Snapshot | `/targets/:targetId/revisions/:targetRevisionId` | 不可变责任合同、适用 Graph、Criterion、Submission 和历史；非活动 Revision 默认只读 |
| Work Detail | `/targets/:targetId/work/:workNodeId` | Task/Gate 输入、责任、结果、Evidence 和历史 |
| Submission Detail | `/targets/:targetId/submissions/:submissionId` | 固定 TargetRevision、ArtifactRevision、VerificationResult、Review 和 Acceptance |
| ArtifactRevision Detail | `/targets/:targetId/artifacts/:artifactRevisionId` | 内容、Diff、来源、Hash、Materialization 和引用 |
| Evidence Detail | `/targets/:targetId/evidence/:evidenceId` | Criterion、Claim、来源、验证器、Hash 和 VerificationResult |
| Agent Run Detail | `/targets/:targetId/runs/:runId` | RunAttempt、日志、成本、Artifact、Evidence、取消和重试 |
| Integration Run Detail | `/targets/:targetId/integrations/:integrationRunId` | IntegrationAttempt、Provider Receipt、Evidence、回调和重试 |

Target Workbench 始终显示 Target 标题、状态、Outcome Owner、当前 Stage、风险、活动 Submission 和 Attention。Graph 是 `Work` 中的高级视图，不成为默认落地页。

## 7. 管理表面

| 表面 | 二级路由 |
| --- | --- |
| Agents | `/agents/definitions`、`/agents/evaluations`、`/agents/deployments` |
| Infrastructure | `/infrastructure/secrets`、`/infrastructure/environments`、`/infrastructure/adapters`、`/infrastructure/plugins` |
| Governance | `/governance/attention`、`/governance/approvals`、`/governance/audit`、`/governance/costs` |
| Settings | `/settings/general`、`/settings/members`、`/settings/access`、`/settings/integrations`、`/settings/billing`、`/settings/experimental` |

Infrastructure 与 Governance 使用和 Settings 一致的上下文二级侧栏。一级入口直接进入第一个可操作页面，不使用只包含链接的聚合列表。二级侧栏只发布具备真实读取、操作、空状态和错误状态的能力；Runner、Runtime Pool、Connector、Storage、Policy 和数据策略在对应能力可用前不显示占位入口。

Agents 使用对象列表型上下文二级侧栏。侧栏主体是当前 Principal 可见的 Agent 列表，提供创建、快速切换、运行状态和选中态；All Agents 是集合入口，Deployments 是运行投影视图，不与 Agent 对象列表竞争主体位置。Definitions 的配置与版本能力归入具体 Agent 工作区；Evaluations 只有在真实评测合同和页面可用后显示。`All`、`Active`、`Paused`、`Error` 和 `Built-in` 是集合页筛选，不定义二级领域栏目。

Infrastructure 的当前页面复用既有 Environment、Secret、Adapter 和 Plugin 能力，Governance 的当前页面复用 Attention、Approval、Activity 和 Cost 能力。Canonical Route 负责稳定导航身份，兼容路由继续保留原有深链、API 和写入所有权。Settings 只承担 Workspace 与实例配置，不重复展示已经归属 Infrastructure 的 Environment、Secret、Adapter 和 Plugin 管理入口。

## 8. 当前路由映射

| 当前表面 | G1 目标 | 迁移规则 |
| --- | --- | --- |
| `/dashboard`、`/dashboard/live` | `/home` | 新 Home 可用后重定向；Live Runs 进入 Home 区块和 Target Runs |
| `/inbox/*`、`/decisions/*` | `/home`、`/governance/attention` | 保留筛选参数和未读/阻塞语义 |
| `/projects/*` | `/projects/*` | 保留现有 Project ID 和深链，增加 Targets 子路由 |
| `/issues/*` | Target Workbench 的 Work 或兼容 Task Detail | 有明确 Target/Work 映射前不强制重定向 |
| `/cases/*` | `/targets/:targetId` | 仅在 Case 与 Target 映射存在且对账通过后重定向 |
| `/goals/*` | Target Objective/Context 或兼容页面 | 不把 Goal 自动转换为 Target |
| `/routines/*` | Target Trigger/Automation 或 Settings Advanced | 保留兼容深链 |
| `/pipelines/*`、`/review-queue` | ProcessTemplate、StageTemplate、Work/Review | 新对象存在前保留实验门禁和深链 |
| `/artifacts` | Target Artifacts 和全局 Artifact Search | 保留全局兼容入口，新增链接优先进入 Target |
| `/agents/all`、`/agents/active`、`/agents/paused`、`/agents/error`、`/agents/builtin` | `/agents/definitions`、`/agents/deployments` | 旧筛选深链保持；新二级导航按 Definition 与 Deployment 组织 |
| `/workspaces`、`/execution-workspaces/*` | `/infrastructure/*` | 保留现有详情深链和运行诊断 |
| `/apps/*`、Tool/Connector 设置 | `/infrastructure/connectors` | Plugin/Provider 自有子路由保持协议兼容 |
| `/approvals/*` | `/governance/approvals` | 分离 Action Approval、Decision、Review 和 Acceptance 后迁移 |
| `/costs`、`/activity`、`/audit` | `/governance/*` | 查询参数和审计范围保持 |
| `/org` | `/settings/members` 或兼容 Org 页面 | 从主导航退出，不删除路由或组织数据 |
| `/company/settings/*` | `/settings/*` 与 `/infrastructure/*` | 通过路由 Adapter 保留旧路径 |
| `/timeline` | Home 最近活动、Target Timeline 或兼容全局 Timeline | 在对象范围明确前保留原筛选和深链 |
| `/status*`、`/learnings` | Home、Governance 或兼容实验页 | 不把实验投影自动提升为新领域对象 |
| `/board-chat` | `/chat` 兼容来源 | 复用成熟聊天组件与本地执行能力；会话迁入独立 Conversation 合同，不把 Issue Comment 或聊天记录作为 Target 事实 |
| `/skills/*`、`/teams-catalog/*` | Agents、Settings Advanced 或兼容 Catalog | 保留发布、导入、Studio 和文件深链 |
| `/company/import`、`/company/export` | Settings Advanced 或兼容迁移页 | 保留数据导入导出和归属语义 |
| `/u/:userSlug` | 用户资料 | 保持全局身份深链，不并入 Workspace 成员设置 |
| `/plugins/*`、Plugin 自有顶层路由 | 原 Plugin 页面 | 继续由 Plugin Route Resolver 处理，不猜测目标栏目 |
| `/design-guide` 与开发/UX Lab | 非生产导航 | 保持开发环境或显式深链访问，不进入产品 IA |

## 9. 兼容与发布规则

1. 新导航 Shell 使用独立的 Workspace-scoped `enableVerrailNavigation` Feature Flag 发布，允许一键回到兼容 Shell；已退役的 `enableStreamlinedLeftNavigation` 不复用为迁移开关；
2. Canonical Route 与旧路由同时注册，旧深链先由 Adapter 解析，再在具备无损映射时重定向；
3. Issue、Case、Goal、Pipeline 或 Approval 没有确定目标对象时继续显示兼容页，不猜测映射；
4. 浏览器历史、刷新、收藏、通知链接、邮件链接、Plugin Launcher 和 Command Palette 必须使用同一 Route Resolver；
5. Workspace 切换保持当前对象语义；目标 Workspace 不存在对应资源时进入明确 Not Found，而不是默认 Dashboard；
6. 新增链接只指向 Canonical Route，旧链接调用量归零并经过一个兼容窗口后才可删除；
7. 路由发布不修改数据库写入所有权，不与领域表迁移绑定在同一个不可回退提交；
8. 导航实验不新增默认出站 Telemetry；验证使用本地路由指标、测试和人工旅程证据；
9. Plugin Slot 继续获得 Workspace 和 Route 上下文，但不得在主导航注入与一级 IA 冲突的核心栏目；
10. G1 以桌面工作台为主要验收表面，Auth、全局 Shell 和兼容页面仍保持现有窄视口基本可用性。
11. 发布新链接前，Workspace 路由根注册表必须识别 `home`、`chat`、`targets`、`infrastructure` 和 `governance`，并由回归测试覆盖所有现存第一方顶层路由与 Plugin 顶层路由，避免把新路由误判为 Workspace Prefix 或 Plugin 路由。
12. `home`、`chat`、`targets`、`infrastructure` 和 `governance` 是 Host 保留路由。发布前必须更新 Plugin routePath 保留表并扫描已安装 Plugin Manifest；发生冲突时阻止该 Workspace 放量，直到 Plugin 获得显式兼容别名或完成版本化迁移，不允许由路由顺序静默遮蔽 Plugin 页面。
13. 导航项、Badge 和聚合计数只显示当前 Principal 有权读取的范围；隐藏导航不是授权机制，直接访问 Canonical Route 仍由服务端权限校验并返回一致的 Permission Denied 或 Not Found。
14. 需要审阅、决定、验收、审计或分享的链接必须指向固定 TargetRevision、Submission、ArtifactRevision、Evidence、Run 或 IntegrationRun，不得只链接到会随活动 Revision 变化的默认 Tab。
15. 每个嵌套对象路由都校验 Workspace 和父对象关系。`workNodeId`、`submissionId`、`artifactRevisionId`、`evidenceId`、`runId` 和 `integrationRunId` 必须是不可变全局标识；ID 存在但不属于 URL 中 Target 的对象不得被渲染或泄露。
16. Verrail 模式中的 Project 裸路由固定进入 Overview，不读取继承 Tasks Tab 缓存；Project 一级操作只创建 Target，`New Task` 不出现在 Project Overview 或 Targets。
17. `/projects/:projectId/issues` 及其筛选深链继续打开同一兼容工作数据；Verrail 新链接使用 `/projects/:projectId/legacy-work`，经典导航继续使用原 Tasks 命名和路径。
18. Project 列表中的 Target 数量、Attention 和健康摘要必须在服务端完成 Principal 授权过滤后计算，不从分页行数、隐藏对象或旧 `taskCount` 推断。
19. Projects 与 Agents 的二级侧栏都以对象切换为主，但遵循各自领域层级。Projects 选中 Project 后展开 Target 列表，Project 管理功能收口在 Project Detail；Agents 选中 Agent 后展开该 Agent 的功能入口。移动端使用同一信息架构的抽屉呈现。

### Target 只读投影前提

首个 Target Workbench 使用版本化 `TargetReadModel`，包含稳定 Target ID、活动 TargetRevision ID、来源对象类型与 ID、Workspace、Project、标题、状态、责任人、Stage、Attention、Artifact、Evidence 和最近运行摘要。它是可重建的只读投影，不是新的领域实体或写入所有者。兼容 Adapter 可以从已对账的 Case、Issue 或其他存量事实构建该投影，但 UI 不得自行合成 Target ID 或猜测 Case/Issue 等价关系。

`TargetReadModel` 与 Case/Issue 的映射、权限、Not Found、缺失字段和来源跳转遵循 [`target-read-model.md`](./target-read-model.md)。不存在可靠投影时继续展示兼容页面，不发布空壳 Target 深链。

## 10. 首个实施切片

首个切片只包含：

- Verrail 品牌应用壳；
- `/home` 操作型入口，复用当前 Attention、Inbox、Live Run 和 Project 数据；
- `/projects` 与 `/projects/:projectId/targets`；
- `/targets/:targetId` 只读 Target Workbench 骨架；
- 新 Sidebar、Command Palette 和 Breadcrumb 的 Canonical Route；
- 旧 Dashboard、Inbox、Projects、Issues 和 Cases 深链兼容；
- Loading、Empty、Error、Permission Denied 和 Not Found 状态。

首个切片不创建新的权威 Target 写模型，不删除旧路由，不迁移 Auth 领域逻辑或身份安全标识，也不迁移 Secret、Plugin、Adapter 或执行恢复逻辑；Auth 表面的 Verrail Display Name 仍按品牌合同处理。

## 10. 验收标准

1. 用户进入 Workspace 后首先看到 Home，而不是 AI 公司 Dashboard；
2. 一级导航只包含 Home、Chat、Projects、Agents、Infrastructure、Governance 和 Settings；
3. 用户从 Home 或 Projects 能进入 Target Workbench，并始终知道当前 Workspace、Project 和 Target；
4. Target Workbench 可回答目标、责任人、阶段、阻塞、产物、证据和下一步行动；
5. 所有旧邮件、通知、收藏、Issue、Case、Agent 和设置深链继续打开正确资源或明确兼容页；
6. Workspace 切换、刷新、前进后退、Command Palette、Breadcrumb 和 Plugin Launcher 行为一致；
7. 中文和英文导航使用 Target、Work、Run、Artifact、Evidence、Review 等统一术语；
8. `Org`、`Goals`、`Routines`、`Pipelines` 和实验页不再占据默认一级导航；
9. Sidebar 折叠、桌面窄窗口、Loading、Empty、Error 和权限不足状态通过截图和交互检查；
10. Review、Acceptance、通知和审计链接固定到不可变版本对象，活动 Revision 变化后仍能打开原上下文；
11. 无权访问的导航、Badge、搜索结果和聚合计数不泄露跨 Workspace 或受限对象信息；
12. 相关组件测试、路由测试、权限测试、locale/parity、`pnpm check:token-gates`、typecheck 和 build 通过。

## 11. 非目标

- 不在导航批次实现完整 Target 数据模型或 Temporal Workflow；
- 不通过 UI 重定向伪造 Case、Issue、Goal 与 Target 的业务等价；
- 不删除兼容 API、路由、表、Feature Flag 或 Plugin Slot；
- 不把所有功能压进一级导航；
- 不用图表 Dashboard、营销卡片或通用聊天替代 Target 与 Attention 工作面。
