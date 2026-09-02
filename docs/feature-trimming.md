# Verrail P0 产品表面审计结论

版本：0.3

状态：`Confirmed`

最后更新：2026-08-25

交付模式：`Audit And Batch`

## 1. Outcome

当前产品功能为 Verrail 提供了可工作的业务基座和后续领域迁移能力。P0 不裁剪现有业务功能，不建立强制删除批次；产品表面审计只负责锁定 i18n 范围。内部设计、UX、性能和开发验证页面不需要翻译，其生产路由清理进入独立工程任务。

## 2. 审计判断

审计每个能力时回答：

1. 是否为当前用户提供真实可用价值；
2. 是否可以演进为 Project、Target、Stage、Artifact、Review、Evidence 或 Acceptance 的组成部分；
3. 是否支撑 Agent、Connector、Runner、Sandbox、Secret、成本、审计或企业部署；
4. 是否承担 SDK 示例、契约测试、性能测试、发布或开发基础设施职责；
5. 是否包含存量数据、后台任务、公开 API、CLI、Plugin 或深链兼容。

功能路线尚未完全确定、当前使用频率有限或默认关闭，都不足以构成删除理由。

## 3. 当前处置

| 处置 | 含义 | P0 动作 |
| --- | --- | --- |
| `Keep` | 当前产品、战略基座或必要开发基础设施 | 保持现有行为，按用户可达性决定是否翻译 |
| `Transform` | 能力需要，语义将迁移为 Verrail 合同 | 保持运行和数据兼容，随 G1 及后续里程碑迁移 |
| `Internal/Excluded` | 内部设计、测试或开发表面 | 不纳入 P0 翻译范围，不代表删除代码 |

P0 没有已批准的 `Delete` 对象。未来只有在产品价值、依赖、数据和替代路径得到明确确认后，才能建立独立 Delete 执行包。

## 4. Keep：产品与战略基座

| 能力 | 保留理由 |
| --- | --- |
| Auth、Workspace/Company 数据边界与访问控制 | 所有治理和企业部署的前提 |
| PostgreSQL/Drizzle、对象存储和 Assets | 领域事实与 Artifact 基座 |
| Dashboard、Inbox、Tasks/Issues、Projects | 继承工作流与深链兼容入口；G1 原生 Target 闭环不从这些对象投影领域事实 |
| Agents、Adapters、Runs、Execution Workspaces | Codex 和未来 Runtime 的执行基础 |
| Routines、Pipelines、Cases、Goals、Approvals | 可演进为 Stage、Work Graph、Review 和 Gate |
| Artifacts、Skills、Skill Studio、Teams Catalog | 产物和版本化 Agent 能力的直接基础 |
| Apps、Tool Gateway、Plugin SDK 和示例 Plugin | Connector、企业扩展和 Plugin 契约测试基础 |
| Secrets、Costs、Timeline、Activity/Audit | 企业治理、追溯和可运营性基础 |
| Company Import/Export | 自托管数据可移植与迁移安全能力 |
| Sandbox Provider、Google Sheets、OpenClaw、Hermes 等 Provider | 企业执行与 Connector 候选 |
| CLI、GitHub、部署、性能脚本和 Storybook | 开发、验证、自托管和标志性交付闭环基础 |

Apps、Pipelines、Cases、Conference Room、Status Cards、Decisions、Goals Sidebar、Built-in Agents、Smoke Lab 等功能继续遵循当前默认关闭策略。P0 不修改其 Feature Flag、路由、数据合同或实现。

## 5. Transform：随 Verrail 领域迁移

| 当前表面 | Verrail 目标 | P0 边界 |
| --- | --- | --- |
| Company 与 Company Settings | Workspace 与 Workspace Settings | 保留 UI 与存储兼容，不扩张 Company 语义 |
| Projects + Issues + Goals + Cases | Compatibility Service | 保持存量旅程和深链；不映射或投影为原生 Target、Collection 或 Work Graph |
| Approvals | Decision、Action Approval、Review、Acceptance | G1/G2 分离责任类型后迁移 |
| Dashboard、Inbox、Decisions | Home + Attention Inbox | 新聚合面可用前不移除现有入口 |
| Artifacts/Work Products | ArtifactRevision + Evidence | 复用文件与存储基础，增加版本合同 |
| Pipelines/Review Queue | Graph、IntegrationTask 与 Review | 复用必要能力，不删除数据路径 |
| Agent 管理 | AgentDefinition、AgentVersion、Deployment、Evaluation | 保留 Adapter 和现有管理能力 |

## 6. Internal/Excluded：不进入 P0 翻译范围

| 表面 | 当前用途 | P0 处置 |
| --- | --- | --- |
| `/dev/task-chat-lab` | DEV-only Task Chat 验证 | 保留，不翻译 |
| `/ux-lab/bootstrap-setup` | UX 状态捕获 | 保留现状，不翻译；生产入口进入工程清理 backlog |
| `/ux-lab/responsible-user-denial` | UX 状态捕获 | 保留现状，不翻译；生产入口进入工程清理 backlog |
| `/ux-lab/cross-issue-collaboration` | UX 状态捕获 | 保留现状，不翻译；生产入口进入工程清理 backlog |
| 顶层 `/tests/perf/long-thread` | 长线程性能测量脚本入口 | 保留测试能力，不翻译；生产入口进入工程清理 backlog |
| `/design-guide` | 内部设计系统展示 | 保留设计参考，不翻译；评估迁入 Storybook 或 DEV-only |
| Storybook | 组件与状态验证 | 保留，不纳入应用翻译验收 |

这些对象不是用户产品功能。是否迁入 DEV-only、Storybook 或删除专用路由，不影响 i18n 启动。

## 7. In Scope：P0 用户表面

| 工作流 | 用户表面 |
| --- | --- |
| 进入产品 | Auth、Board Claim、CLI Auth、Invite、Onboarding、无 Workspace/Company 状态 |
| 应用壳 | 桌面与移动导航、账号菜单、Workspace/Company 切换、Command Palette、Search、Breadcrumb、Route Error、Not Found |
| 日常关注 | Dashboard、Live Runs、Inbox、Decisions、Timeline |
| 工作管理 | Projects、Project Detail、Tasks/Issues、Task Detail、Routines、Workspaces 与 Execution Workspaces |
| Agent 执行 | Agents、New Agent、Agent Detail、Run 状态、日志与工作区入口 |
| 交付治理 | Artifacts、Approvals、Costs、Activity/Audit |
| 能力与扩展 | Skills、Apps 和 Plugin Host Chrome；Plugin/Provider 自有名称、说明与内容保留原文 |
| 设置与管理 | General、Profile、Members、Invites、Secrets、Environments、Access、Heartbeats、Import/Export、Plugins、Adapters |
| 公共状态 | Loading、Empty、Error、Confirmation、Danger、Toast、Tooltip 和 Status Label |

默认关闭的实验功能不属于 P0 完成门禁。它们复用的公共应用壳和共享组件必须支持当前 locale；专用表面在进入默认用户旅程前完成翻译验收。

## 8. i18n Surface Lock

翻译范围审计按以下步骤执行：

1. 列出当前导航和认证后可达的用户页面；
2. 补充认证、Onboarding、Settings、错误、空状态、通知、确认和关键深链；
3. 标记 `In Scope` 与 `Internal/Excluded`；
4. 按用户工作流组织翻译批次；
5. 在 i18n 验收中检查全部 `In Scope` 表面，不要求内部页面中文化。

退出条件：翻译团队可以基于稳定清单工作，不需要等待任何功能删除。

## 9. 独立工程清理规则

内部生产路由清理不属于 P0 功能裁剪。建立清理任务时必须：

1. 确认测试、截图、性能脚本和 Storybook 的替代入口；
2. 对生产路由采用 DEV-only 门禁或完整移除，不能留下不可维护的半删除状态；
3. 使用 `rg`、类型检查、相关测试和生产构建验证残余引用；
4. 不删除共享组件、SDK 示例、Provider、Plugin 合同和基础设施能力；
5. 不修改已发布历史 migration，涉及数据时提供明确迁移和回滚方式。

## 10. P0 验收

- 现有业务功能和信息架构保持可用；
- 默认关闭的实验功能继续保持默认关闭；
- 用户可达页面和公共状态具有明确翻译清单；
- 内部设计、测试和开发表面具有明确排除清单；
- i18n 不以任何功能删除为前置条件；
- 企业执行、扩展、数据导出和存量兼容基础保持可运行。
