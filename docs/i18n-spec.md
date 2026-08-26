# Verrail P0 中文 i18n 规格

版本：1.0

状态：`Implemented`

最后更新：2026-08-25

交付模式：`Audit And Batch`

## 1. Outcome

中文用户首次打开 Verrail 时可以自动获得简体中文界面，也可以随时在英文和简体中文之间切换。显式选择在刷新和重新打开浏览器后保持有效，界面不存在半中文半英文的核心旅程。

i18n 在 P0 用户可达页面和内部排除表面锁定后实施，不以功能删除为前置条件。翻译范围以 [`feature-trimming.md`](./feature-trimming.md) 的 Surface Lock 为输入，不翻译 DEV-only、UX Lab、性能页、Design Guide 和 Storybook。

P0 实现包含 `en` 与 `zh-CN` 注册表、浏览器语言检测、显式语言切换、安全本地持久化、`<html lang>` 同步、locale-aware formatter、资源结构校验和核心用户旅程翻译。Profile Settings 是语言控制的权威入口。

## 2. P0 语言范围

正式支持以下语言：

| Locale | 名称 | 角色 |
| --- | --- | --- |
| `en` | English | 默认语言和翻译键事实源 |
| `zh-CN` | 简体中文 | P0 完整支持语言 |

仓库中不完整的其他 locale 不作为受支持语言暴露。繁体中文、日文等语言在完成完整翻译、校验和验收后再进入语言列表。

## 3. 语言解析与持久化

语言来源按以下优先级解析：

1. 用户显式选择并存入 `localStorage` 的 `verrail.locale`；
2. 浏览器 `navigator.languages` 中第一个可映射语言；
3. 默认 `en`。

映射规则：

- `zh`、`zh-CN`、`zh-SG` 映射到 `zh-CN`；
- 未正式支持的中文区域在 P0 映射到 `zh-CN`；
- `en-*` 映射到 `en`；
- 非法、损坏或不可访问的持久化值被忽略；
- 存储不可用时语言切换仍在当前会话生效。

语言改变后同步更新 i18next、React 视图和 `<html lang>`。P0 语言均为从左到右，不引入 RTL 布局合同。

## 4. 用户体验

- `Settings > Profile` 提供语言选择菜单，使用语言自身名称显示 `English` 与 `简体中文`；
- 选择后立即生效，不要求保存整张 Profile 表单或刷新页面；
- 首次访问采用浏览器语言，产品不显示打断式语言弹窗；
- 登录、退出和 Workspace 切换不覆盖本地语言选择；
- 加载、错误、空状态、确认、危险动作和通知使用同一当前语言；
- 日期、时间、数字和金额使用统一 locale formatter，不用字符串拼接模拟本地化。

P0 持久化是浏览器级偏好，不增加用户表字段。跨设备语言同步属于后续能力，可以在身份设置合同稳定后加入。

## 5. 翻译边界

需要翻译：

- 导航、页面标题、设置、对话框、表单、按钮和工具提示；
- 错误、空状态、加载状态、确认、通知和状态标签；
- Onboarding、帮助内容和面向用户的操作说明。

默认保留原文：

- Verrail、Codex、GitHub 等品牌与产品名；
- API、HTTP、MCP、CLI、SQL、模型名、键盘键和协议标识；
- URL、路径、代码、日志、邮件正文和 Provider 原始诊断；
- 用户创建的 Project、Target、Agent、Artifact 和评论内容。
- Plugin/Provider manifest 提供的名称、说明和 Plugin 自有页面内容。

默认关闭的实验功能不属于 P0 核心翻译门禁；公共应用壳、共享组件和启用后进入正常用户旅程的表面仍使用同一 i18n 合同。

服务端稳定错误码与 UI 翻译分离。UI 根据可识别错误码显示本地化消息，未知诊断保留可检查的原始信息。

## 6. 实现合同

### Locale Registry

`ui/src/i18n/locales.ts` 是受支持语言注册表，只暴露通过完整校验的 locale。语言显示名、规范化和解析逻辑集中在 i18n 模块，页面不自行判断语言代码。

### Resource Contract

`en` 是键结构事实源，`zh-CN` 必须保持完全同构。现有 locale validation 继续检查缺失键、额外键、变量占位符、意外 HTML/URL 和值长度。

### React Contract

组件使用 `useTranslation()` 和稳定语义键，不以英文句子作为键，不在 JSX 中拼接可翻译句子。含变量的句子使用插值；复数、日期和数字使用 i18next/Intl 能力。

### Persistence Contract

读取和写入存储通过一个可测试适配器完成。适配器捕获浏览器隐私模式、配额和安全异常，不让 i18n 初始化阻塞应用启动。

## 7. 审计与批次

| 批次 | 用户表面 | 完成标准 |
| --- | --- | --- |
| A | i18n 核心、检测、持久化、语言菜单 | 刷新、无存储、无效 locale 和切换路径通过 |
| B | 应用壳、认证、Onboarding、导航、全局错误 | 首次访问和进入 Workspace 全中文可用 |
| C | Projects、Targets/兼容 Issues、Agents、Runs | 主交付工作流无硬编码英文 chrome |
| D | Artifact、Evidence、Review、Acceptance/兼容审批 | 关键审阅与决定语义准确且无歧义 |
| E | Infrastructure、Secrets、Settings、成本与审计 | 高风险设置和运维路径完整翻译 |
| F | 低频保留表面、帮助与回归清扫 | 可达 UI 审计完成，残余项有明确处置 |

每个批次按页面和用户旅程合并处理，不为每个字符串建立独立任务。

## 8. 验证与验收

自动验证至少覆盖：

- 持久化选择优先于浏览器语言；
- 浏览器中文区域正确映射到 `zh-CN`；
- 非法持久化值和存储异常安全回退；
- `en` 与 `zh-CN` 键、占位符和结构完全一致；
- 切换语言立即更新页面和 `<html lang>`；
- 关键格式化结果遵循当前 locale。

人工验收覆盖桌面与移动宽度下的首次访问、语言切换、刷新、登录、创建 Project、进入 Agent/Run、查看 Artifact/Evidence、审批/验收和危险确认。中文文本不得溢出、遮挡或改变控件稳定尺寸。

## 9. P0 非目标

- 跨设备偏好同步；
- 自动翻译用户内容、日志或 Agent 输出；
- RTL 支持；
- 完整国际时区与多币种产品策略；
- 在 P0 同时正式支持简体中文之外的新增语言。

## 10. 验证状态

自动验证覆盖 locale 规范化、持久化优先级、浏览器语言回退、存储异常、资源键与占位符一致性、运行时切换、`<html lang>` 同步以及日期、数字和金额格式化。Workspace typecheck、UI token gates 和生产构建通过。

浏览器验收确认中文浏览器首次进入认证界面时使用简体中文且 `<html lang="zh-CN">` 生效；390 x 844 视口不存在水平溢出。完整应用服务在当前 macOS 主机上受缺失的 `@embedded-postgres/darwin-arm64` 本机包限制，完整数据旅程由相关 React/Vitest 回归覆盖。
