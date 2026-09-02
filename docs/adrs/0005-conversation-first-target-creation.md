# ADR-0005：Conversation-first Target 创建与可选 Collection 归类

状态：`Accepted`

日期：2026-09-01

## 上下文

Verrail 的主要交互入口包含 Web Chat、钉钉、飞书和企微。一个群聊或私聊是长期 Conversation，同一会话会承载查询、讨论、一次性调用和多个不同目标。如果普通消息自动创建 Target，系统会快速产生重复、模糊且无法验收的目标；如果创建 Target 必须先选择 Project，企业聊天入口又会退化为传统项目管理表单。

现有产品合同把 Target 定义为责任与验收中心，同时把 Project 定义为非权限边界，但仍固定 `Project -> Target` 所有权并要求在 Project 中创建 Target。这一约束不是安全、审计、执行或验收所必需，并与 Agent 后端管理平台的直接交互心智冲突。

## 决策

1. Target 直接且唯一属于 Workspace；Collection 是可选归类，不是 Target 的必选父级；
2. 一个 Provider 群聊或私聊在一个 Workspace 中映射为一个持久 Conversation；
3. 普通 Conversation 消息不创建 Target；只有明确创建目标的用户意图才启动 TargetCreationDraft；
4. Agent 通过多轮会话补齐 Draft，但不能自行确认创建；
5. 完整 Draft 必须由具备权限的人类确认，确认后才以幂等命令创建 Target 和首个 TargetRevision；
6. TargetRevision 固定创建时有效的责任、验收、风险、资源和策略引用，不继承之后可变的 Collection 展示信息或兼容 Project 字段；
7. 全局 `New Target` 和 Channel 命令进入会话草拟流程，长表单仅可作为受控的高级或兼容入口；
8. 存量 `project_id`、Project API 和 `/projects/*` 路由在迁移期保留为可空兼容字段、筛选和深链，不继续定义新产品层级。

详细交互与命令合同见 [`../conversation-target-creation.md`](../conversation-target-creation.md)。

## 后果

- 用户可以直接从 Chat 或企业 Channel 建立目标，不需要先理解 Project；
- Conversation 与 Target 保持清晰边界，聊天不会污染交付事实；
- Workspace Policy、ResourceScope 和版本化 TargetRevision 承担原先错误寄托在 Project 默认值上的治理责任；
- Target 列表、Home、Attention 和搜索是主要工作入口，Collection 提供可选聚合，Project 只保留在 Compatibility Service；
- 数据库、Go Domain API、TypeScript API、TargetReadModel 和 UI 使用可选 `collectionId`；
- Provider Conversation 身份通过 `ProviderConversationBinding` 映射；`TargetCreationDraft` 使用不可变修订、人工确认和固定幂等键转换为 Target；
- Project-scoped Case/Issue 不投影为 Target，也不映射为 Collection。

## 否决方案

- 每条消息自动创建 Target：产生噪声，缺少责任与验收条件；
- 仅用关键词匹配创建目标：无法可靠处理歧义、否定和多语言表达；
- 保留 Project 为必填但自动创建隐藏 Project：把产品负担藏进数据模型，并制造错误的策略继承；
- Agent 补齐后自动创建 Target：把推断误当作人类责任确认；
- 只保存聊天摘要而不保存结构化 Draft：无法恢复、校验版本或保证幂等转换。
