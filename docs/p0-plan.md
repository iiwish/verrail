# Verrail P0 交付计划

版本：1.0

状态：`Complete`

最后更新：2026-08-25

实施状态：`Complete`

## 1. P0 Outcome

P0 建立一个中文用户可以直接使用、产品边界清楚的 Verrail。当前产品功能保持不变；锁定翻译范围后直接实施简体中文 i18n。

P0 不设置功能裁剪目标、删除批次或代码减量指标。当前审计没有发现必须先删除的业务功能。内部设计、UX 和性能验证页面不进入翻译范围，其生产暴露问题作为独立工程清理项处理，不阻塞 i18n。

## 2. 执行策略

P0 采用 `Audit And Batch`，不为文本和 locale 改动拆分过重的治理流程：

1. 先审计并锁定用户可达表面；
2. 按应用壳和用户工作流批量翻译；
3. 每个批次运行 locale/parity、相关单测和代表性界面检查；
4. P0 收口时运行类型检查、关键 E2E 和生产构建；
5. 与 i18n 无关的继承测试或构建失败记录为已知基线问题，不阻塞翻译批次。

## 3. Workstream S：翻译表面锁定

目标：确认 P0 需要中文化的用户可达界面，不改动现有业务功能和信息架构。

交付切片：

1. **S1 User Surface Inventory**：列出导航、核心路由、认证、设置、对话框、错误、空状态、通知和关键深链；
2. **S2 Translation Boundary**：把正常用户旅程标记为 `In Scope`，把 DEV-only、UX Lab、性能页、Design Guide 和 Storybook 标记为 `Internal/Excluded`；
3. **S3 Surface Lock**：形成可达页面和公共状态清单，作为 i18n 批次与验收的唯一输入。

该工作流只确定翻译边界，不要求删除功能、路由、服务、Schema、Plugin、Provider 或示例代码。完整审计结论见 [`feature-trimming.md`](./feature-trimming.md)。

## 4. Workstream A：简体中文 i18n

目标：在 S3 锁定的产品表面上支持 `en` 与 `zh-CN`，提供浏览器语言检测、显式切换、本地持久化和完整的核心界面翻译。

交付切片：

1. **A1 Locale Core**：收敛受支持 locale，完成规范化、检测优先级、持久化适配器和 `<html lang>`；
2. **A2 Language Control**：在 Profile Settings 加入即时生效的语言菜单；
3. **A3 Core Journeys**：按应用壳、认证、Project/Task、Agent/Run、Artifact/Review、Infrastructure/Settings 批量翻译；
4. **A4 Quality Gate**：执行键与占位符校验、可达界面硬编码字符串审计、关键旅程和响应式验收。

完整合同见 [`i18n-spec.md`](./i18n-spec.md)。

## 5. 非阻塞工程清理

以下内部页面存在生产路由或公开入口，但不是 P0 业务功能，也不是 i18n 前置条件：

- `/ux-lab/bootstrap-setup`；
- `/ux-lab/responsible-user-denial`；
- `/ux-lab/cross-issue-collaboration`；
- 顶层 `/tests/perf/long-thread`；
- `/design-guide`。

这些入口可以在独立清理包中迁入 DEV-only 或 Storybook，或者在替代验证路径可用后完整删除。清理包遵循 [`feature-trimming.md`](./feature-trimming.md) 的删除保护规则，不与 i18n 批次混合。

当前全量测试中的本机依赖、macOS 路径和端口分配问题，以及 Skills Catalog 远程 manifest 拉取导致的构建不稳定，也进入独立工程基线任务；它们只有在直接影响相关 i18n 验证时才阻塞对应批次。

## 6. 依赖与执行顺序

```text
P0 Contract confirmed
        |
        v
S1 -> S2 -> S3
        |
        v
A1 -> A2 -> A3 -> A4

Internal route and inherited baseline cleanup: optional and non-blocking
```

- Workstream S 只锁定翻译范围，当前结论为不裁剪业务功能；
- S3 完成后直接进入 A1-A4；
- 内部路由和继承基线清理可以独立安排，不阻塞 locale 核心或翻译批次；
- P0 不启动 Target/Stage 新数据模型、CubeSandbox 生产接入或 Go 服务提取。

## 7. 里程碑

| 里程碑 | 结果 | 验收证据 |
| --- | --- | --- |
| `P0-M0 Surface Lock` | S1-S3 完成 | 用户可达页面、公共状态和翻译排除清单 |
| `P0-M1 Locale Foundation` | A1-A2 完成 | locale 单测、语言检测与持久化演示 |
| `P0-M2 Chinese Product` | A3-A4 完成 | 中英文关键旅程、字符串审计和响应式验收 |

## 8. P0 完成标准

1. 当前业务功能、导航和信息架构保持可用；
2. P0 用户可达页面和翻译排除项具有明确清单；
3. 中文浏览器首次访问默认使用简体中文；
4. 用户可以在英文和简体中文之间即时切换，刷新后保持选择；
5. 核心可达旅程不存在未处置的英文应用 chrome；
6. Auth、Adapter、Plugin、Runtime、Secret、成本、审计和存量数据保护边界保持可用；
7. locale/parity 校验、相关测试和关键旅程通过；
8. 类型检查、E2E 或生产构建中的已知失败具有明确归因，新增失败全部解决。

## 9. 产品决定

1. P0 不裁剪现有业务功能，完成翻译范围锁定后直接实施 i18n；
2. DEV-only、UX Lab、性能页、Design Guide 和 Storybook 不进入 P0 翻译范围；
3. 公开内部路由的清理由独立工程任务处理，不作为 i18n 门禁；
4. P0 正式语言仅为 `en` 与 `zh-CN`；
5. 语言偏好采用浏览器本地持久化，不做跨设备同步。

## 10. 交付状态

P0 的用户表面锁定、locale 基础、语言控制和核心工作流翻译均已完成。当前业务功能、路由和信息架构保持不变，产品不执行功能裁剪。

| 验证项 | 结果 |
| --- | --- |
| Locale 检测、持久化、运行时切换与 formatter 单测 | 通过 |
| `en` / `zh-CN` 键结构与占位符一致性 | 通过 |
| 核心页面与共享组件代表性回归 | 通过，最终批次 10 个测试文件、141 个测试 |
| UI token gates | 通过 |
| Workspace TypeScript typecheck | 通过 |
| 生产构建 | 通过 |
| 中文浏览器首次访问 | 通过，页面与 `<html lang>` 均为 `zh-CN` |
| 390 x 844 中文认证界面 | 通过，无水平溢出或越界元素 |

全量 Vitest 运行结果为 298 个测试文件通过、7 个失败，2896 个测试通过、19 个失败、1 个未处理错误。失败集中在继承实现的 macOS `/tmp` 规范路径、运行时端口分配、listener 诊断、worktree seed 前置条件和缺失的 `@embedded-postgres/darwin-arm64` 本机包，与 P0 i18n 改动无直接关系。

可达界面字符串审计按核心旅程、低频高级表面和技术/来源内容分类处理。核心应用壳、认证、Onboarding、Project/Task、Agent/Run、Artifact/Approval、Infrastructure 和 Settings 主路径进入 P0 验收；默认关闭的实验表面、深层高级编辑器、Provider/Plugin 自有内容和原始诊断不作为核心语言门禁。
