# Verrail 文档索引

版本：0.2

状态：`Confirmed`

最后更新：2026-08-26

## 文档职责

`docs/` 是 Verrail 产品、领域模型和目标架构的唯一事实源。这里的文档描述要建设的 Verrail，不能由当前继承代码中的 Paperclip 命名或行为反向定义。

| 文档 | 职责 |
| --- | --- |
| [`product-goals.md`](./product-goals.md) | 产品目标、阶段路线、退出门槛和近期优先级 |
| [`delivery-process.md`](./delivery-process.md) | 专业交付流程、风险模式、状态和完成门禁 |
| [`p0-plan.md`](./p0-plan.md) | P0 的翻译表面锁定、中文 i18n 批次与验收顺序 |
| [`i18n-spec.md`](./i18n-spec.md) | 中文语言检测、切换、持久化、翻译与验收合同 |
| [`feature-trimming.md`](./feature-trimming.md) | P0 产品功能保留结论、翻译排除表面与独立清理规则 |
| [`constitution.md`](./constitution.md) | 不可绕过的治理、安全、责任和交付原则 |
| [`product-design.md`](./product-design.md) | 用户、产品对象、核心旅程、范围与验收标准 |
| [`operational-ontology.md`](./operational-ontology.md) | 核心实体、状态、关系、授权类型和系统不变量 |
| [`brand-migration.md`](./brand-migration.md) | Verrail 品牌表达、资产、兼容标识边界与迁移批次 |
| [`navigation-contract.md`](./navigation-contract.md) | 一级信息架构、Canonical Route、旧深链兼容与首个导航切片 |
| [`target-read-model.md`](./target-read-model.md) | 首个 Target 只读投影的来源映射、标识、字段、API、权限和重建合同 |
| [`architecture.md`](./architecture.md) | 当前兼容控制平面、Temporal、Go 目标内核、执行平面、云与企业部署架构 |
| [`execution-runtime.md`](./execution-runtime.md) | Runner、Sandbox、CubeSandbox、租约与数据出站合同 |
| [`adrs/0001-typescript-foundation.md`](./adrs/0001-typescript-foundation.md) | 采用 Paperclip TypeScript 基座并硬分叉的决策 |
| [`adrs/0002-control-and-execution-planes.md`](./adrs/0002-control-and-execution-planes.md) | 控制平面、执行平面与渐进式 Go 演进边界 |
| [`adrs/0003-temporal-durable-orchestration.md`](./adrs/0003-temporal-durable-orchestration.md) | Temporal 作为耐久编排内核、PostgreSQL 作为业务事实源的决策 |
| [`adrs/0004-go-control-plane-replatform.md`](./adrs/0004-go-control-plane-replatform.md) | Go 目标内核、重构范围、工作量与迁移决策 |

## 权威顺序

文档冲突时按以下顺序处理：

1. `constitution.md` 中的不可协商原则；
2. `product-goals.md` 中的产品目标、阶段边界和退出门槛；
3. `product-design.md` 中的用户价值与产品范围；
4. `operational-ontology.md` 中的对象语义和系统不变量；
5. `brand-migration.md`、`navigation-contract.md` 与 `target-read-model.md` 中的公开品牌、产品表面和首个 Target 投影合同；
6. `architecture.md` 与 `execution-runtime.md` 中的实现边界；
7. `adrs/` 中已接受的单项技术决策。

技术实现不能静默改变产品语义，界面文案不能替代权限、审批或验收合同。

## 继承实现参考

`doc/`、`docs/api/`、`docs/adapters/`、`docs/cli/`、`docs/deploy/` 和 `docs/specs/` 中保留的材料用于解释当前 TypeScript 基座。它们可能仍包含 `Paperclip`、`company`、`issue`、`board` 和 `heartbeat` 等内部命名。

这些材料具有实现参考价值，但不是 Verrail 产品事实源。领域重构必须以本目录中的 Verrail 合同为目标，同时在每个迁移阶段维持已有 API、数据与运行行为可验证。

## 审核状态

| 文档 | 状态 | 审核动作 |
| --- | --- | --- |
| 产品目标 | `Confirmed` | 领域中心、阶段路线、Go 目标内核和 Temporal 必选决策已确认 |
| 交付流程与 P0 | `Confirmed` / `Complete` | 交付门禁已确认，P0 中文与表面锁定已完成 |
| 项目章程 | `Confirmed` | Target/Submission/Evidence/Acceptance 与 Temporal 原则已确认 |
| 产品设计 | `Confirmed` | v0.2 对象模型、首个纵向闭环与非目标已确认 |
| 运行本体 | `Confirmed` | TargetRevision、Submission、四类节点完成事实、Temporal 与五类授权已确认 |
| 品牌与导航合同 | `Confirmed` | 品牌资产、身份兼容、主导航、稳定深链、路由映射与首个切片已确认 |
| TargetReadModel 合同 | `Confirmed` | 来源资格、稳定标识、状态映射、权限、API、降级和重建规则已确认 |
| 架构与执行运行时 | `Confirmed` | Go 迁移边界、Temporal、Runner、Sandbox 候选和 Cloud 扩展边界已确认 |
| ADR-0001/0002/0003 | `Accepted` | 基座、执行平面和 Temporal 决策已确认，后续变更需新 ADR |
| ADR-0004 | `Accepted` | Go 目标内核、兼容服务、工作量、迁移方法和停止条件已确认 |

## 维护规则

- 文档直接描述 Verrail 的当前定义，不承担项目改名史或上游变更日志。
- 产品路线只在 `product-goals.md` 维护；执行任务、PR 记录和测试证据不写回路线正文。
- 核心术语只在 `operational-ontology.md` 定义，其他文档引用同一语义。
- 影响授权、凭证、审计、外部 Effect、证据、验收或分布式执行的改动必须经过人工评审。
- 上游实现文档只有在仍对应可运行代码时保留；被领域实现替代后随代码一起删除或改写。
- 新的规范性文档放在 `docs/`；临时调查、生成报告和 PR 截图不得混入规范目录。
