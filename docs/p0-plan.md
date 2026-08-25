# Verrail P0 交付计划

版本：0.1

状态：`Ready_For_User_Review`

最后更新：2026-08-25

实施门禁：产品责任人确认本计划后进入 `In_Progress`

## 1. P0 Outcome

P0 建立一个中文用户可以直接使用、产品边界清晰的 Verrail 基线。它只包含两个并行工作流：完整的简体中文界面，以及对继承产品表面的可控裁剪。

## 2. 工作流 A：简体中文 i18n

目标：支持 `en` 与 `zh-CN`，提供浏览器语言检测、显式切换、本地持久化和核心可达界面的完整翻译。

交付切片：

1. **A1 Locale Core**：收敛受支持 locale，完成规范化、优先级、持久化适配器和 `<html lang>`；
2. **A2 Language Control**：在 Profile Settings 加入即时生效的语言菜单；
3. **A3 Core Journeys**：按应用壳、认证、Project/Target 兼容路径、Agent/Run、Artifact/Review、Infrastructure/Settings 批量翻译；
4. **A4 Quality Gate**：键与占位符校验、硬编码字符串审计、关键旅程和响应式验收。

完整合同见 [`i18n-spec.md`](./i18n-spec.md)。

## 3. 工作流 B：产品功能裁剪

目标：把默认产品表面收口到 Home、Projects、Agents、Infrastructure、Governance 和 Settings，保护企业执行基座，并为 Target Workbench 重构清理空间。

交付切片：

1. **B1 Inventory**：建立路由、导航、API、服务、Schema、后台任务、Feature Flag 和依赖清单；
2. **B2 Surface Allowlist**：隐藏和冻结非核心产品表面，保留可观测兼容入口；
3. **B3 First Deletion Batch**：纵向删除无数据风险的实验、示例和开发表面；
4. **B4 Migration Backlog**：为 Company、Issue、Approval、Pipeline 等 Transform 对象确定映射与终止条件。

完整决策见 [`feature-trimming.md`](./feature-trimming.md)。

## 4. 依赖与执行顺序

```text
Process + P0 Contract confirmed
        |
        +--> A1 --> A2 --> A3 --> A4
        |
        +--> B1 --> B2 --> B3
                       |
                       +--> B4 --> G1 Target Workbench
```

- A1 与 B1 可以并行；
- B2 确定“可达 UI”后，A3 不翻译确定删除的页面；
- 高风险设置、错误和兼容页面在删除完成前仍需翻译；
- B3 只处理低风险删除，涉及数据和公开 API 的删除进入 B4 及后续 Governed Delivery；
- P0 不启动 Target/Stage 新数据模型、CubeSandbox 生产接入或 Go 服务提取。

## 5. 里程碑

| 里程碑 | 结果 | 验收证据 |
| --- | --- | --- |
| `P0-M1 Foundation` | A1、A2、B1 完成 | locale 单测、语言切换演示、裁剪清单 |
| `P0-M2 Focused Product` | B2 完成 | 默认导航/Onboarding E2E、兼容深链检查 |
| `P0-M3 Chinese Core` | A3 完成 | 核心旅程中英文截图与字符串审计 |
| `P0-M4 Smaller Baseline` | B3、A4 完成 | 删除证据、完整检查、响应式验收 |

## 6. P0 完成标准

1. 中文浏览器首次访问默认使用简体中文；
2. 用户可以在英文和简体中文之间即时切换，刷新后保持选择；
3. 核心可达旅程不存在未处置的英文应用 chrome；
4. 默认产品入口只展示 Verrail 主线，冻结表面不再产生新数据；
5. 至少一个低风险功能包完成纵向删除；
6. Auth、Adapter、Plugin、Runtime、Secret、成本、审计和存量数据保护边界保持可用；
7. locale 校验、类型检查、相关测试、E2E 和生产构建通过；
8. 实施证据绑定到固定提交，残余风险和 G1 迁移项可追踪。

## 7. 需要确认的产品决定

1. P0 正式语言仅为 `en` 与 `zh-CN`；
2. 语言偏好先采用浏览器本地持久化，不做跨设备同步；
3. Freeze 表面默认从导航和 Onboarding 隐藏，但先保留兼容深链；
4. 第一批 Delete 只处理实验、示例和开发表面；
5. Plugin、Skill、Tool 与 Sandbox 基础保留，但不作为 P0 主导航产品面。
