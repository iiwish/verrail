# Verrail 后续产品目标与路线

版本：0.1

状态：`Ready_For_User_Review`

最后更新：2026-08-25

审核要求：确认产品差异化、首个纵向闭环、阶段顺序和企业执行边界后进入实施

## 1. 目标

Verrail 是面向专业 AI 交付的可信控制平面。它不以“再提供一个能写代码的 Agent”为价值，而是把多个 Agent、人类决策者、CI/CD 和企业运行环境组织成可恢复、可审计、可验收的交付系统。

核心结果不是任务完成或 Agent 显示为在线，而是一个目标产生了可审阅产物、独立证据、明确责任和可追溯验收。

```text
Project -> Target -> Stage -> Work Graph
        -> Agent Run / Human Decision / Integration Run
        -> Artifact Revision -> Evidence -> Review -> Acceptance
```

## 2. 差异化

Codex 等 Harness 负责高质量执行单个编码任务；Verrail 负责跨任务、跨角色、跨运行时的组织事实和交付责任。通用 Agent 编排产品可以调度工作，Verrail 必须进一步回答：

1. 这次运行固定了哪个 AgentVersion、模型、Skill、权限与环境；
2. 谁有权调用、决策、批准外部动作和验收结果；
3. 产物对应哪个目标、阶段、Base Revision 和内容 Hash；
4. 测试与检查是否来自独立、可验证的 Evidence，而不是 Agent 自述；
5. 中断、重试、改派或 Runner 失联后，权威状态是否仍然一致；
6. 企业代码与凭证能否留在客户网络，同时由统一控制平面治理。

用户选择 Verrail 的理由应当是“交付可信且可运营”，而不是“界面里能启动更多 Agent”。

## 3. 产品原则

1. **采用成熟执行基座**：保留 Paperclip 的 TypeScript、PostgreSQL、Adapter、Plugin、运行日志、Secret、成本和工作区能力，不重复建设通用 Harness。
2. **围绕交付事实重构**：一级对象采用 Project、Target、Stage、Artifact、Review、Agent Run、Evidence 与 Timeline。
3. **责任类型不可混用**：调用权、执行权、决定权、行动批准权和验收权独立计算。
4. **人类与确定性系统是一等节点**：HumanTask、DecisionGate、ReviewGate、AcceptanceGate 和 IntegrationTask 与 AgentTask 共同组成 Work Graph。
5. **一个产品，多种部署**：本地、自托管、Verrail Cloud 与客户 VPC Runner 使用同一领域合同。
6. **执行面可替换**：HostTrusted、CubeSandbox、容器或未来 Kubernetes 只实现 Runtime Backend，不拥有业务事实。
7. **Go 是演进手段，不是近期目标**：只有清晰的服务边界、容量或隔离收益成立时，才通过协议逐步提取 Go 服务。

## 4. 基座策略

| 类别 | 范围 |
| --- | --- |
| 保留 | 认证与用户、PostgreSQL/Drizzle、S3/本地存储、Adapter SDK、Plugin SDK、Secret、成本、运行日志、工作区与 Runtime Service 基础 |
| 重构 | Company/Tenant 语义、CEO/组织图、Issue 单指派模型、Board 审批、Heartbeat 导航与 AI 公司创建流程 |
| 新建 | Project/Target/Stage、版本化 Agent 生命周期、Work Graph、五类授权、Artifact/Evidence/Acceptance、Execution Gateway、Runner Fleet、Cloud Tenant Cell |
| 延后 | 通用工作流设计器、插件市场、多区域主动写入、全量 Go 重写、移动端完整工作台、专业文档或代码编辑器 |

## 5. 标志性纵向闭环

首个可对外验证的闭环固定为：

```text
GitHub 需求
  -> 创建 Target 并固定验收条件
  -> 选择已发布的 Codex AgentVersion
  -> 在受控 Workspace/Sandbox 执行
  -> 生成 CodeChange ArtifactRevision
  -> 独立 Review 与 CI IntegrationTask 产生 Evidence
  -> 责任人完成 Acceptance
  -> 创建或更新 Pull Request
  -> Timeline 保留全部版本、权限、日志和决定
```

这个闭环必须能演示失败、重试、人工拒绝、修订后重新验收和安全回滚，不能只覆盖一次成功路径。

## 6. 阶段路线

### G0：分叉基线与产品边界

目标：让代码库、文档和开发入口明确服务 Verrail。

交付：

- Verrail 规范文档、ADR 和术语表成为事实源；
- 上游历史计划、AI 公司营销叙事和无关截图退出规范目录；
- 建立上游 Commit、许可证、NOTICE 和依赖来源记录；
- 建立品牌与内部包名重构清单，不在同一提交中机械改完所有标识；
- 现有 TypeScript 基座可安装、启动、测试和回归。

退出门槛：新贡献者能区分“当前继承实现”和“Verrail 目标合同”，核心检查保持绿色。

### P0：中文可用与产品收口

目标：形成一个中文用户可以直接使用、产品边界清晰且验证可靠的 Verrail 基线，为 G1 产品骨架降低认知和工程负担。

交付：

- 保持现有业务功能和信息架构，锁定用户可达页面与内部排除表面；
- 锁定最终可达产品表面后完成 `en` 与 `zh-CN` i18n，包含浏览器检测、语言切换、本地持久化和 locale 校验；
- 保护 Adapter、Plugin、Runtime、Sandbox、Secret、成本、审计和存量数据兼容边界。

退出门槛：核心可达旅程中英文可用；locale 与相关回归验证通过；现有业务功能和企业执行基础保持可用。

实施合同见 [`p0-plan.md`](./p0-plan.md)、[`i18n-spec.md`](./i18n-spec.md) 和 [`feature-trimming.md`](./feature-trimming.md)。

### G1：Verrail 产品骨架

目标：让首屏和导航表达可信交付，而不是 AI 公司组织管理。

交付：

- Workspace、Project、Target、Stage 和 Timeline 基础数据模型；
- Target Workbench 成为主工作面，包含 Overview、Graph、Artifacts、Evidence、Runs、Timeline；
- Attention Inbox 汇总待决定、待批准、待评审和待验收事项；
- 现有 Company/Project/Issue 能通过兼容映射逐步迁移，不进行一次性破坏式换表。

退出门槛：用户不需要理解 CEO、组织图或 Heartbeat，就能创建 Target、看到阶段与责任人，并进入真实运行记录。

### G2：可信交付闭环

目标：完成标志性 GitHub 到验收闭环。

交付：

- AgentDefinition、AgentVersion、Deployment 与 EvaluationRun；
- 版本化 WorkGraph 和六类节点；
- ArtifactContract、ArtifactRevision、Evidence、DeliveryReview 与 Acceptance；
- GitHub Connector、CI Evidence、结构化 Action 与参数绑定 Approval；
- Run、Artifact、Evidence、Review、Acceptance 的统一 Timeline。

退出门槛：同一 Target 可证明 Agent 版本、代码差异、独立 CI 结果和责任人验收；修改产物后旧验收自动失效。

### G3：企业执行平面

目标：把执行从控制平面进程中独立出来，并支持 Linux 强隔离试点。

交付：

- 版本化 Runner Protocol、Execution Gateway、Runner Enrollment 与凭证轮换；
- Node/Run/Sandbox Lease、fencing token、容量和心跳；
- HostTrusted 与 ContainerIsolated 两种清晰的信任配置；
- CubeSandbox 通过 `SandboxDriver` 完成安全、恢复、性能和运维 Spike；
- 客户 VPC Runner 使用出站连接，执行代码与运行时 Secret 可留在客户网络。

退出门槛：Runner 失联、重复回传和重试不会覆盖新 Attempt；强隔离任务不会被错误调度到 HostTrusted。

### G4：Cloud 与企业部署

目标：形成可运营的托管服务和私有执行组合。

交付：

- Account、Billing、Quota、Region、Fleet 与 Tenant Control Cell；
- SSO、SCIM、细粒度 RBAC、审计导出、备份恢复与保留策略；
- Managed CubeSandbox 与 Private Runner 共享调度合同；
- 租户隔离、数据驻留、Secret Provider 和企业网络策略；
- 升级、回滚、容量、SLO 和事故响应运行手册。

退出门槛：设计伙伴可以在真实仓库与企业身份体系中连续运行，完成恢复演练并通过安全评审。

### G5：质量与持续改进

目标：让 Agent 质量和交付质量可比较、可发布、可回滚。

交付：

- 版本化评测集、基线、回归检测与发布门禁；
- ImprovementProposal、人工批准、灰度与回滚；
- 跨 Target 的交付质量、成本、周期和失败类型分析；
- 经过 Acceptance 的可信团队记忆与 Skill 晋升。

退出门槛：Agent 升级由评测和生产证据驱动，失败版本可快速回滚且不破坏历史追溯。

## 7. 近期实施顺序

1. 锁定 P0 用户可达页面和内部排除表面，不裁剪现有业务功能；
2. 完成 locale 检测、语言切换、本地持久化和锁定表面的中英文翻译；
3. 定义 Project/Target/Stage 数据合同和兼容映射；
4. 构建 Target Workbench 的只读真实数据骨架；
5. 引入 ArtifactRevision、Evidence、Review 与 Acceptance 最小合同；
6. 打通一个固定 Codex Deployment 的 GitHub 交付闭环；
7. 把 Runner Protocol 和 SandboxDriver 从进程实现中抽成稳定接口；
8. 在真实 Linux 环境完成 CubeSandbox Spike，再决定生产准入；
9. 以设计伙伴工作流验证 Cloud/Private Runner 组合。

## 8. 成功指标

- 首次可验收交付时间：从 Target 创建到首个可审阅 ArtifactRevision；
- 证据完整率：已验收交付中同时具备版本、权限、环境、CI 与内容 Hash 的比例；
- 恢复成功率：服务或 Runner 中断后无需人工改库即可收敛的运行比例；
- 人工注意力质量：Inbox 中确实需要责任人处理的项目比例；
- 运行时可替换性：同一合同在至少两个 Adapter 或 Runtime Profile 上通过；
- 企业数据边界：私有 Runner 模式下不允许出站的数据保持在客户网络；
- 回滚时间：AgentVersion、Deployment 或交付版本发生回归后的恢复时间。

## 9. 非目标

- 不复制 Codex 的代码生成、终端交互或 Agent Loop；
- 不把 Issue Tracker、聊天工具或组织图换皮当作产品完成；
- 不建设通用低代码工作流平台；
- 不替代 GitHub、Figma、飞书或专业 IDE 的深度编辑能力；
- 不在没有独立收益证明时启动全量 Go 重写；
- 不以支持最多 Adapter、最多 Agent 或最多页面作为近期成功标准。

## 10. 待确认事项

1. 首批设计伙伴更偏向个人开发者、小团队还是受监管企业；
2. Target 的默认 Stage 模板是否固定为 Define、Execute、Verify、Accept；
3. Cloud 首发采用共享控制平面加租户隔离，还是每租户独立 Control Cell；
4. CubeSandbox 的目标安全等级和运维责任由谁承担；
5. 首个付费价值更偏向企业私有 Runner、治理审计，还是托管执行额度。

本文在上述事项得到用户确认后转为 `Confirmed`，再拆分 G0 与 G1 的实施任务。
