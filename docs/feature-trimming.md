# Verrail P0 功能裁剪方案

版本：0.1

状态：`Ready_For_User_Review`

最后更新：2026-08-25

交付模式：`Governed Delivery`

## 1. Outcome

P0 让用户看到的产品结构服务于 Verrail 的可信交付主线，而不是继承的 AI 公司、组织图、通用任务管理和实验功能集合。裁剪同时降低导航噪声、维护面积和后续领域迁移成本，不破坏战略性的 Adapter、Plugin、Runner、Sandbox、Secret、审计和成本基座。

## 2. 判断标准

每个功能按以下问题评估：

1. 是否直接服务 `Project -> Target -> Stage -> Artifact -> Review -> Evidence -> Acceptance`；
2. 是否是 GitHub + Codex 标志性闭环的必要能力；
3. 是否支撑企业身份、安全、私有执行、Sandbox、成本或审计；
4. 是否与专业系统重复，或主要服务 AI 公司/组织隐喻；
5. 是否包含存量数据、后台任务、公开 API、插件或迁移风险；
6. 删除后能否显著降低产品认知或工程维护成本。

## 3. 四类处置

| 处置 | 含义 | P0 动作 |
| --- | --- | --- |
| `Retain` | 目标产品的战略基座 | 保持可用，限制无关扩张 |
| `Transform` | 能力需要，但产品语义需要迁移 | 保留兼容层，建设新入口与合同 |
| `Freeze` | 当前不进入主产品，仍有依赖或潜在价值 | 从导航和 Onboarding 隐藏，停止新增能力 |
| `Delete` | 无战略价值且依赖可控 | 按完整纵向切片删除代码、配置、文档和数据合同 |

## 4. 决策矩阵

### Retain

| 能力 | 保留理由 | 边界 |
| --- | --- | --- |
| Auth、Workspace 数据边界与访问控制 | 所有治理和企业部署的前提 | `companyId` 只作迁移存储，不扩张 Company 语义 |
| PostgreSQL/Drizzle、对象存储、Assets | 领域事实和 Artifact 基座 | 新对象必须 Workspace scoped |
| Agents、Adapters、Runs、Execution Workspaces | Codex 与后续 Runtime 的执行基础 | 逐步迁移到版本化 Agent 与 Run 合同 |
| Secrets、Costs、Activity/Audit | 企业治理和可运营性基础 | 区分审计、Telemetry、Observability 与本地 Run Log |
| Plugin SDK、Tool Gateway、Sandbox Provider | Private Runner、CubeSandbox 和 Connector 扩展点 | P0 不把通用插件市场作为主产品卖点 |
| GitHub、CLI、部署与运行时基础 | 标志性闭环和自托管入口 | 品牌与领域命令按兼容计划迁移 |

### Transform

| 当前表面 | Verrail 目标 | P0 动作 |
| --- | --- | --- |
| Company 与 Company Settings | Workspace 与 Workspace Settings | UI 使用 Workspace，保留存储兼容 |
| Projects + Issues + Goals + Cases | Project + Target + Stage + Work Graph | 冻结新语义扩张，建立兼容映射 |
| Approvals | Decision、Action Approval、Review、Acceptance | 先分离用户文案和入口，再拆分数据合同 |
| Dashboard、Inbox、Decisions | Home + Attention Inbox | 汇总真正需要责任人的项目 |
| Artifacts/Work Products | ArtifactRevision + Evidence | 保留文件基础，增加版本和证明合同 |
| Pipelines/Review Queue | Graph、IntegrationTask 与 Review | 复用必要执行能力，不保留通用 Pipeline 产品表面 |
| Agent 管理 | AgentDefinition、AgentVersion、Deployment、Evaluation | 保留 Adapter，替换雇员和汇报线隐喻 |

### Freeze

以下表面从主导航、Onboarding、默认 feature flag 和产品文档中退出，但在依赖审计完成前不删除底层数据：

- Org Chart、CEO、汇报线和 AI 公司创建流程；
- Board Chat、Conference Room Chat 和通用 Agent 聊天入口；
- Apps Marketplace、应用画廊和面向终端用户的 Advanced Tools 目录；
- Skills Studio、公开 Skills Catalog 和 Teams Catalog；
- Status Cards、Summaries、Feedback Voting 和通用 Goals 侧栏；
- Routines、Experimental Cases、Smoke Lab 和内置演示 Agent；
- 通用 Pipelines、Learnings 和独立 Review Queue 表面；
- Company Import/Export 和多 Company 管理工作流；
- Design Guide、UX Lab、性能演示和开发专用页面。

Plugin、Skill 和工具能力可以继续作为内部或企业扩展基础存在，但不占据 P0 信息架构。

### Delete Candidates

第一批删除候选只包含无存量业务数据或可由测试证明不可达的开发、示例和营销表面：

- UX/组件实验路由、性能测试页和设计展示入口；
- 示例 MCP server、示例 plugin 和 kitchen-sink/demo 资产；
- 已退出导航且没有外部引用的历史重定向与旧营销文案；
- 只服务已冻结功能的截图、教程和种子演示数据。

Google Sheets、OpenClaw、Hermes、内置 Agent、Skills/Teams Catalog 等 Provider 或 Catalog 在确认设计伙伴需求和依赖图前保持 `Freeze`，不直接判定删除。

## 5. 裁剪顺序

### Slice 1：产品表面收口

- 建立 Verrail 导航 allowlist：Home、Projects、Agents、Infrastructure、Governance、Settings；
- 从默认路由、侧栏、Command Palette、Onboarding 和空状态隐藏 Freeze 表面；
- 保留直达兼容路由并记录访问量，避免立即破坏存量用户；
- 把实验能力统一放入内部开发门禁，不在普通设置中逐项暴露。

退出条件：新用户只能看到 Verrail 主线，不需要理解 Company/CEO/Issue/Heartbeat 隐喻。

### Slice 2：冻结旧写入

- 为 Transform 表面建立 Verrail 兼容 API 或读取投影；
- 停止旧入口创建新的 Org Chart、Goal、Case、Routine 等对象；
- 标记后台任务、Feature Flag、通知和深链依赖；
- 记录旧 API 与路由调用量。

退出条件：主旅程不再产生待删除领域的新数据，旧数据仍可读取或导出。

### Slice 3：低风险纵向删除

- 删除不可达 UI、路由注册、API client、服务、测试、文档和 package 依赖；
- 清理无调用 Feature Flag、环境变量、种子数据和 CI 任务；
- 每个删除包使用 reachability、类型、测试和构建证明无残余引用。

退出条件：删除后产物体积、依赖或维护面有可测下降，核心旅程保持绿色。

### Slice 4：领域迁移后删除

- 完成 Company/Issue/Approval 等数据回填、对账和权限验证；
- 关闭旧写入并观察兼容窗口；
- 删除旧表、后台任务和 API 前提供导出、迁移和回滚方案；
- 用真实数据恢复演练证明迁移可运营。

退出条件：旧路径调用量归零，数据对账通过，没有长期双写。

## 6. 保护清单

P0 裁剪不得误删：

- Adapter SDK、Codex 执行与事件归一化；
- Plugin SDK、Sandbox Provider 与 Runtime Service 扩展合同；
- Execution Workspace、工作树、租约、取消和恢复能力；
- Secret 引用、成本账本、Activity/Audit、对象存储；
- 自托管部署、CLI 诊断和未来 Private Runner 所需的基础设施；
- 存量用户数据的读取、导出和明确迁移路径。

## 7. 每个删除包的证据

1. 功能入口和依赖图；
2. UI、API、服务、Schema、任务、配置和文档处置清单；
3. 存量数据量与迁移/导出决定；
4. 公开 API、Plugin、CLI 和深链兼容结论；
5. 相关类型检查、单元、集成、E2E 和构建结果；
6. 回滚方式与负责人；
7. 删除前后的可维护性指标，例如路由、依赖、bundle 或代码量变化。

## 8. P0 验收

- 默认信息架构只表达 Verrail 核心工作台；
- Freeze 功能不再从普通用户旅程创建新数据；
- 至少完成一批低风险开发/示例表面的纵向删除；
- Transform 对象拥有明确兼容映射和终止条件；
- 保护清单能力保持可运行；
- 类型检查、测试和生产构建通过；
- 后续 G1 可以在更小、更清楚的产品表面上建设 Target Workbench。
