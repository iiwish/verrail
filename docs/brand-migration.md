# Verrail 品牌迁移合同

版本：0.2

状态：`Confirmed`

最后更新：2026-08-26

变更要求：公开品牌、兼容标识、身份安全边界或归属规则发生变化时重新评审本合同

## 1. 品牌定义

公开产品名是 `Verrail`，官网主域名是 `verrail.ai`。产品类别是 Agent 管理与可信交付控制平面。核心承诺是让 Agent、人类和确定性系统产生可恢复、可审阅、证据充分且由责任人验收的交付。

公开产品表达围绕以下链路组织：

```text
Target -> Work -> Run / Human Result / Integration Result
       -> Artifact + Evidence -> Submission -> Review -> Acceptance
```

`Verrail` 在英文和简体中文界面中保持同一拉丁字母写法，不翻译、音译、复数化或与 Workspace 名称拼接。Verrail 不使用 AI 公司、CEO、雇员、组织图或“更多 Agent 等于更高价值”的品牌叙事。品牌语气保持专业、克制、精确和可信，不使用夸张自治承诺。

## 2. 品牌层次

| 层次 | 用户含义 | 命名规则 |
| --- | --- | --- |
| Product | 产品与控制平面 | 始终显示 `Verrail` |
| Workspace | 租户、团队与数据边界 | 显示用户定义的 Workspace 名称，不与产品品牌合并 |
| Project / Target | 用户工作对象 | 使用领域对象名称，不使用品牌前缀 |
| Adapter / Provider | Codex、Claude、GitHub 等外部能力 | 保留提供方正式名称 |
| Compatibility | 继承的 package、CLI、API、环境变量、数据库和 Plugin 标识 | 在兼容窗口内保留 `paperclip` / `paperclipai` 技术名称 |
| Attribution | MIT、NOTICE、第三方与上游来源 | 永久保留真实归属，不改写为 Verrail 原创 |

## 3. 品牌资产合同

首个品牌实施批次使用一套完整、可检查的资产系统：

- 主标志：适合应用壳、仓库和文档的 Verrail wordmark；
- App mark：在 16、24、32 和 48 CSS px 下仍可辨认的简洁图形；
- Favicon：SVG、16x16、32x32、48x48、180x180、192x192、512x512 和 maskable 版本；
- 明暗模式：每个标志提供浅色背景、深色背景和单色版本；
- 安全区与最小尺寸：资产目录附带可执行的使用说明；
- 文本回退：图片加载失败时显示 `Verrail`，不显示旧品牌或空白；
- 元数据：浏览器标题、PWA manifest、安装名称、分享标题和可访问文本使用同一产品名。

UI 继续使用 `ui/src/index.css` 作为唯一 Token 根。品牌实施可以新增经过审核的语义品牌 Token，但不得在组件中直接写颜色、间距、圆角、字号、阴影或 motion 值。品牌资产不得使用装饰性紫蓝渐变、玻璃光效或与可信交付无关的复杂图形。

品牌资产完成视觉审核后才进入应用壳替换；不使用临时 Logo 或未审批图形占位。

## 4. 标识分类与迁移边界

| 分类 | 代表表面 | G1 处置 |
| --- | --- | --- |
| 用户可见产品品牌 | 页面标题、PWA 名称、favicon、Auth、Onboarding、应用壳、错误页、邮件与通知模板 | 切换为 Verrail |
| 公共产品材料 | 根 README、安装首页、截图、示例文案、公共产品文档 | 切换为 Verrail 产品叙事，同时保留上游归属 |
| CLI 展示文本 | 帮助、启动日志、服务描述、交互式 Onboarding | 显示 Verrail；命令名保持兼容 |
| Published package | `paperclipai`、`@paperclipai/*`、Plugin SDK import | 保留，直到独立版本化迁移方案获得批准 |
| 配置与环境变量 | `PAPERCLIP_*`、配置目录、服务名、默认端口 | 保留并记录兼容别名，不在品牌批次机械改名 |
| 数据与协议 | `company_id`、旧 API 路径、数据库表、历史 migration、事件类型 | 作为兼容技术标识保留，按领域切片迁移 |
| 浏览器本地状态 | `paperclip.*` localStorage、Service Worker Cache、IndexedDB key、已安装 PWA | 通过读取旧键、版本化 Cache、兼容迁移和升级验证切换，不直接失效或长期展示混合品牌 |
| 实例与 Worktree 标识 | 运行时 title、favicon、预览色、Worktree 名称和注入的 meta key | 保留环境辨识能力；显示名使用 Verrail，现有 `paperclip-*` meta key 在兼容窗口内继续读取 |
| 身份与安全标识 | Session Cookie、OAuth/OIDC issuer/client/redirect URI、Passkey RP ID、JWT audience、签名 Key ID、Invite 与 CLI Auth callback | 公共 Display Name 可以切换为 Verrail；协议标识只通过独立 Auth 迁移修改，品牌批次不得使现有会话、凭证或回调失效 |
| Plugin Host | bridge global、slot、package import、manifest schema | 保持协议兼容，新的 Verrail Display Name 与协议标识分离 |
| Telemetry | 生成合同、事件名、Endpoint、调用方 | 不进入普通品牌批次，按严格隐私审查流程单独处理 |
| CSS 与代码符号 | `paperclip-*` class、内部函数和兼容类型 | 只有在降低维护成本且具备自动迁移验证时处理 |

任何品牌 PR 都必须声明自己修改的是 Display Name、Public Contract、Compatibility Identifier 还是 Attribution。禁止对仓库执行无分类的全局 `Paperclip -> Verrail` 替换。

## 5. 迁移批次

### B0：品牌资产与资产清单

产出主标志、App mark、favicon 全尺寸、明暗/单色版本、资源目录和使用规则。完成目标市场中的产品名、域名、包命名空间和基础商标冲突筛查；未解决的高风险冲突阻止公开发行，但不阻止本地视觉原型。使用截图验证 16px favicon、折叠 Sidebar、Auth、Onboarding 和浏览器标签。

### B1：应用壳和安装表面

替换 HTML title、PWA manifest、favicon、应用壳、Loading、Not Found、Auth、Onboarding 和安装欢迎表面。品牌资产使用版本化 URL 或等价 Cache 失效策略，已安装 PWA、离线回退和更新后的 Service Worker 不长期保留旧资产。Worktree 或隔离实例继续通过运行时 title、favicon 和预览色与正式实例清晰区分。Workspace 名称继续作为用户当前位置锚点，Verrail 品牌不与 Workspace Logo 竞争。

### B2：用户可见文案

按 Auth、Workspace、Project/Target、Agent/Run、Infrastructure/Governance、通知和错误路径批量审计旧品牌文案。技术标识、Provider 原文、日志和用户内容保持原样。

### B3：公共仓库与发行材料

更新根 README、CLI README、公共截图、安装说明和发行元数据。保留 MIT、NOTICE、上游 Commit 和第三方来源。

### B4：CLI 展示与兼容别名

CLI 和服务日志显示 Verrail，继续接受既有命令、环境变量和配置目录。帮助与诊断明确区分 `Verrail` 产品名和仍受支持的兼容命令，不把兼容命令伪装成已完成迁移。任何新的 CLI 名称只作为别名引入，并包含冲突检测、迁移提示和回滚路径。

### B5：技术标识评估

逐项评估 package、Plugin SDK、环境变量、缓存键、服务名和代码符号。只有实际产品、安全或维护收益大于生态破坏时才迁移；数据库历史 migration 和上游归属不重写。

## 6. 验收标准

1. 核心用户旅程不混用 Paperclip 与 Verrail 产品名；
2. Workspace、Project、Target、Provider 和 Verrail 的名称层次清楚；
3. 浏览器标题、PWA、favicon、Auth、Onboarding、应用壳和错误页使用同一资产版本；
4. 浅色、深色、折叠 Sidebar、中文和英文表面都通过视觉检查；
5. 旧 localStorage、Service Worker Cache、IndexedDB、配置和深链不会因品牌更新静默失效，已安装 PWA 可以升级到一致品牌；
6. `paperclipai` CLI、`@paperclipai/*` package 和 Plugin import 在兼容窗口内继续工作；
7. 现有登录会话、OAuth/OIDC 回调、Passkey、Invite、CLI Auth 和签名验证不因 Display Name 切换失效；
8. Telemetry 相关改动不混入普通品牌 PR；
9. LICENSE、NOTICE、上游来源和第三方归属保持完整；
10. 公开发行前完成可追溯的名称、域名、包命名空间和基础商标冲突筛查；
11. `pnpm check:token-gates`、locale/parity、相关 UI 测试、typecheck、build 和代表性浏览器截图通过；
12. 正式实例、Worktree 预览和自定义运行时品牌仍可被清楚区分，旧运行时 meta key 不会因显示名切换失效。

## 7. 非目标

- 不在品牌批次重命名数据库表、历史 migration、API 字段或所有代码符号；
- 不同时重构领域行为、权限、状态机或执行恢复；
- 不用 Logo 替代 Workspace 定位、Target 状态或产品信息架构；
- 不把上游兼容标识包装成新的 Verrail 公共承诺；
- 不为追求统一而破坏已发布 CLI、Plugin 和自托管安装。
