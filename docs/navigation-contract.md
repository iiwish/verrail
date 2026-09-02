# Verrail 导航与路由迁移合同

版本：0.5

状态：`Confirmed`

最后更新：2026-09-01

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
| 3 | Targets | Workspace 内 Target 列表、筛选、状态和可选 Collection 归类 | `/targets` |
| 4 | Agents | AgentDefinition、Version、Evaluation 和 Deployment | `/agents` |
| 5 | Infrastructure | Runner、Runtime、Connector、Secret、Storage 和环境 | `/infrastructure` |
| 6 | Governance | Attention、Policy、Approval、Audit、Cost 和数据策略 | `/governance` |
| 7 | Settings | Workspace、成员、角色、集成、计费和实验配置 | `/settings` |

Search 与 Command Palette 是全局命令，不作为领域栏目。创建主命令是 `New Target`；该命令打开或创建 Conversation 并启动结构化目标草拟，不展示 Project 必填长表单。`New Task` 只在 Target Workbench 的 Work 上下文或兼容页面出现。

Organization/Org Chart、Goals、Routines、Pipelines、Cases、Skills 和 Apps 不进入默认一级导航。它们按目标语义进入 Target、Agents、Infrastructure、Settings、二级 Advanced 区域或兼容深链。

## 4. Home

Home 是操作型收件箱，不是图表 Dashboard。默认按以下优先级展示：

1. 需要当前用户 Decision、Approval、Review 或 Acceptance 的 Attention；
2. 失败、阻塞、失联或等待输入的 Target 和 Run；
3. 分配给当前用户的活动 Target；
4. 最近发生实质变化的 Target 和 Submission；
5. 运行容量或策略异常。

Home 支持 Collection、Role、Stage、Status 和 Owner 筛选。没有真实数据时展示可执行空状态，不展示演示图表或营销说明。

## 5. Chat

Chat 是紧随 Home 的一级工作入口。`/chat` 展示新会话入口和最近会话，`/chat/:conversationId` 展示持久线程。上下文侧栏提供 New chat、Search、Pinned、Recent 和 Archived；基础管理包含创建、自动命名、重命名、置顶、搜索、归档和恢复，不以硬删除作为默认操作。

Conversation 属于当前 Workspace。一个 Provider 群聊或私聊映射为一个持久 Conversation；Web Chat 创建独立 Conversation。Conversation 可以显式绑定 Target、可选 Collection、Stage 或 ArtifactRevision。对话回复中的 TargetCreationDraft、Target、Run、ActionRequest、Approval、Artifact、Evidence、Review 和 Acceptance 必须作为可跳转、可检查的对象呈现。聊天记录不构成 Target、Target 完成、Evidence、外部 Effect 批准或 Acceptance。

普通消息不会出现目标草稿。只有用户明确要求创建目标时，系统才显示 TargetCreationDraft，通过后续多轮消息补齐缺失信息，并在授权人确认完整版本后创建 Target。具体合同见 [`conversation-target-creation.md`](./conversation-target-creation.md)。

## 6. Target 与可选 Collection 路由

规范产品层级是 `Workspace -> Target -> Work Graph -> Run / Artifact / Evidence / Acceptance`。Target 直接进入 Target Workbench，Work 只在 Target 上下文内创建。Collection 是 Target 的可选关联，可以提供跨 Target 的只读工作聚合，但必须按 Target 分组，不表达领域所有权。Project 和 Issue 不进入 Verrail 导航或 Target 归属关系。

Targets 使用对象列表型上下文二级侧栏。侧栏直接提供当前 Principal 可见的 Target 切换和创建入口；Target 列表页提供状态与 Attention 筛选。进入 Target Workbench 后保持选中 Target。Collection 作为可选筛选和属性显示，不占据 Target 面包屑，也不要求用户先选择归类。

Collections 是 Targets 下的轻量管理表面，使用 `/collections` 创建分组，并通过 `/targets?collectionId=:collectionId` 查看关联 Target。Collection 不进入主导航一级菜单，也不拥有 Target。

| 对象 | Canonical Route | 主要表面 |
| --- | --- | --- |
| Target 列表 | `/targets` | Workspace 内 Target、筛选、Attention、状态和可选归类 |
| Target Workbench | `/targets/:targetId` | 默认跳转 Overview |
| Target Tab | `/targets/:targetId/:tab` | `overview`、`work`、`runs`、`artifacts`、`evidence`、`acceptance`、`stages`、`submission`、`timeline` |
| TargetRevision Snapshot | `/targets/:targetId/revisions/:targetRevisionId` | 不可变责任合同、适用 Graph、Criterion、Submission 和历史；非活动 Revision 默认只读 |
| Work Detail | `/targets/:targetId/work/:workNodeId` | Task/Gate 输入、责任、结果、Evidence 和历史 |
| Submission Detail | `/targets/:targetId/submissions/:submissionId` | 固定 TargetRevision、ArtifactRevision、VerificationResult、Review 和 Acceptance |
| ArtifactRevision Detail | `/targets/:targetId/artifacts/:artifactRevisionId` | 内容、Diff、来源、Hash、Materialization 和引用 |
| Evidence Detail | `/targets/:targetId/evidence/:evidenceId` | Criterion、Claim、来源、验证器、Hash 和 VerificationResult |
| Agent Run Detail | `/targets/:targetId/runs/:runId` | RunAttempt、日志、成本、Artifact、Evidence、取消和重试 |
| Integration Run Detail | `/targets/:targetId/integrations/:integrationRunId` | IntegrationAttempt、Provider Receipt、Evidence、回调和重试 |
| Collection 列表 | `/collections` | 可选长期归类、活动 Target 和健康；能力可用前不显示入口 |
| Collection Targets | `/collections/:collectionId/targets` | 预设 Collection 筛选的 Target 列表 |

Target Workbench 始终显示 Target 标题、状态、Outcome Owner、当前 Stage、风险、活动 Submission 和 Attention。一级对象 Tab 按 `Work Graph`、`Runs`、`Artifacts`、`Evidence`、`Acceptance` 表达交付链；Stages、Submission 和 Timeline 是同一 Target 的过程投影与审阅入口。

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
| `/projects/*` | 不进入 Verrail 一级信息架构 | 继承实现可以保留独立路由，但不得跳转、筛选或创建 Target |
| `/issues/*` | Target Workbench 的 Work 或兼容 Task Detail | 有明确 Target/Work 映射前不强制重定向 |
| `/cases/*` | 不进入 Verrail 一级信息架构 | 继承实现可以保留独立路由，但不得自动转换或重定向为 Target |
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
16. Collection 中的 Target 数量、Attention 和健康摘要必须在服务端完成 Principal 授权过滤后计算，不从分页行数或隐藏对象推断。
17. Targets 与 Agents 的二级侧栏都以对象切换为主。Targets 直接展示 Workspace-scoped Target 列表并保持当前 Target 选中态；不得复用 Projects 二级侧栏、Project 列表或 Project 面包屑。Collection 只作为可选筛选和属性；Agents 选中 Agent 后展开该 Agent 的功能入口。移动端使用同一信息架构的抽屉呈现。

### Target 只读投影前提

Target Workbench 使用版本化 `TargetReadModel`，包含稳定 Target ID、活动 TargetRevision ID、Workspace、可选 Collection、标题、状态、责任人、Stage、Attention、Artifact、Evidence 和最近运行摘要。它从原生 Target 事实重建，不是新的领域实体或写入所有者；UI 不得从 Project、Case 或 Issue 合成 Target ID。

`TargetReadModel` 的权限、Not Found、缺失字段和版本语义遵循 [`target-read-model.md`](./target-read-model.md)。不存在原生 Target 事实时返回 Not Found，不发布空壳 Target 深链。

## 10. G1 实施切片

基础切片包含：

- Verrail 品牌应用壳；
- `/home` 操作型入口，复用当前 Attention、Inbox、Live Run 和 Project 数据；
- `/chat` 持久会话、基础会话管理和本地受限兼容运行时；
- `/targets` Workspace-scoped Target 列表，`/collections` 管理可选分组；
- `/targets/:targetId` 只读 Target Workbench 骨架；
- 新 Sidebar、Command Palette 和 Breadcrumb 的 Canonical Route；
- 旧 Dashboard、Inbox、Projects、Issues 和 Cases 深链兼容；
- Loading、Empty、Error、Permission Denied 和 Not Found 状态。

Conversation-first 创建切片包含：

- Provider 群聊/私聊与内部 Conversation 的稳定绑定；
- 显式创建目标意图和可恢复 TargetCreationDraft；
- 多轮补全、结构化确认卡片和授权人确认；
- `collectionId` 可选的幂等 Target 创建命令；
- 创建成功后的 Conversation ContextBinding、目标卡片和 Target Workbench 跳转；
- 普通消息、歧义意图、并发草稿、权限不足和安全重试测试。

两个切片都保留旧路由，不迁移 Auth 领域逻辑或身份安全标识，也不迁移 Secret、Plugin、Adapter 或执行恢复逻辑；Auth 表面的 Verrail Display Name 仍按品牌合同处理。

## 11. 验收标准

1. 用户进入 Workspace 后首先看到 Home，而不是 AI 公司 Dashboard；
2. 一级导航只包含 Home、Chat、Targets、Agents、Infrastructure、Governance 和 Settings；
3. 用户从 Home、Chat 或 Targets 能进入 Target Workbench，并始终知道当前 Workspace 和 Target；Collection 仅在存在关联时作为可选属性显示；
4. Target Workbench 可回答目标、责任人、阶段、阻塞、产物、证据和下一步行动；
5. 所有旧邮件、通知、收藏、Issue、Case、Agent 和设置深链继续打开正确资源或明确兼容页；
6. Workspace 切换、刷新、前进后退、Command Palette、Breadcrumb 和 Plugin Launcher 行为一致；
7. 中文和英文导航使用 Target、Work、Run、Artifact、Evidence、Review 等统一术语；
8. `Org`、`Goals`、`Routines`、`Pipelines` 和实验页不再占据默认一级导航；
9. Sidebar 折叠、桌面窄窗口、Loading、Empty、Error 和权限不足状态通过截图和交互检查；
10. Review、Acceptance、通知和审计链接固定到不可变版本对象，活动 Revision 变化后仍能打开原上下文；
11. 无权访问的导航、Badge、搜索结果和聚合计数不泄露跨 Workspace 或受限对象信息；
12. 相关组件测试、路由测试、权限测试、locale/parity、`pnpm check:token-gates`、typecheck 和 build 通过。
13. 普通 Conversation 消息不显示目标草稿；显式创建意图进入多轮补全，确认成功后跳转到不依赖 Collection 的 Target Workbench。

## 12. 非目标

- 不在导航批次实现完整 Target 数据模型或 Temporal Workflow；
- 不通过 UI 重定向伪造 Case、Issue、Goal 与 Target 的业务等价；
- 不删除兼容 API、路由、表、Feature Flag 或 Plugin Slot；
- 不把所有功能压进一级导航；
- 不用图表 Dashboard、营销卡片或通用聊天替代 Target 与 Attention 工作面。
