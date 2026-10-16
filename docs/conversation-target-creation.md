# 会话驱动的 Target 创建合同

版本：0.1

状态：`Confirmed`

最后更新：2026-09-01

变更要求：会话映射、显式创建意图、草稿状态、确认门禁、Target 创建命令或 Channel 身份边界发生变化时重新评审本合同

## 1. 目的

Verrail 把钉钉群、飞书群、企微群和各平台私聊映射为 Workspace 内的持久 Conversation。Conversation 承载长期对话、上下文和多个工作意图，但普通消息不会自动创建 Target。

只有用户明确要求创建目标时，系统才创建结构化 `TargetCreationDraft`，通过当前 Conversation 的后续消息补齐目标、责任、验收、风险和资源上下文。具备权限的人类确认完整草稿后，系统才提交幂等 Target 创建命令，并在同一事务中形成 Target、首个 TargetRevision、AuditEvent 与 outbox event。

```text
Provider Group / Direct Chat / Web Chat
  -> Conversation
  -> ordinary messages: discuss, query or invoke
  -> explicit create-target intent
  -> TargetCreationDraft
  -> multi-turn completion
  -> reviewable confirmation card
  -> authorized human confirmation
  -> Target + TargetRevision
  -> ConversationContextBinding(Target, TargetRevision)
```

## 2. 会话边界

### Conversation

一个 Provider 群聊在一个 Workspace 中映射为一个 Conversation；一个 Provider 私聊同样映射为一个 Conversation。Web Chat 创建独立 Conversation。一个 Conversation 可以长期存在并先后产生零个、一个或多个 Target，一个 Target 也可以被多个有权 Conversation 引用。

Conversation 保存消息连续性和上下文引用，不拥有 Target、Run、Artifact、Evidence、ActionApproval、DeliveryReview 或 Acceptance 事实。归档 Conversation 不取消其已经创建的 Target。

Web 会话提供相关目标管理：关联已有目标不改变当前焦点，切换目标可自动建立关联，解除当前目标关联同时清空焦点。关系命令与焦点命令共享 `contextVersion`、行锁和幂等收据；过期确认返回冲突，不自动套用新版本。解除关联只移除当前目标引用，目标修订、历史消息快照、创建草稿和执行事实保留。归档会话允许查看进度与关联目标，但修改关系需要先恢复会话。

相关目标面板按需读取目标工作台的当前活动图节点、待处理事项和结果状态。节点完成计数与验收状态分别展示；不存在活动节点时展示空状态，不以模型总结或草稿图推断运行进度。目标侧提供活动及归档关联会话回链，并支持创建聚焦该目标的新会话。读取和操作使用当前 Workspace 权限，关联不是授权。

### ProviderConversationBinding

Connector Plugin 把 Provider 特有身份归一为 `ProviderConversationBinding`，至少包含 Workspace、Connection、Provider 会话类型、外部会话稳定标识和内部 Conversation。`(connection_id, external_conversation_id)` 在一个 Workspace 中唯一。

群聊默认只在明确 `@Agent`、命令、卡片操作或 Workspace 配置允许的触发条件下响应。私聊消息可以直接进入 Conversation，但仍不因此创建 Target。Provider 消息顺序、撤回状态和 Thread 标识不能直接推进 Target 状态。

### 并发草稿

群聊允许不同用户同时草拟目标。每个 TargetCreationDraft 固定发起人和来源消息；后续消息必须通过回复、卡片、命令参数或明确草稿引用绑定到对应 Draft，不能把群内所有消息自动吸收到最近草稿。没有可靠引用时，Agent 必须询问用户选择草稿。

## 3. 显式创建意图

以下行为可以启动 TargetCreationDraft：

- 用户明确表达“创建目标”“新建目标”“把这件事设为目标”等语义；
- 用户执行 `/target`、`New Target` 或等价结构化命令；
- 用户在目标草稿卡片中选择“开始创建”。

以下行为不能自动启动 TargetCreationDraft：

- 普通提问、讨论、总结、翻译或信息查询；
- “帮我看看”“试一下”“分析一下”等没有目标创建语义的请求；
- Agent 根据主题重要性自行推断用户想建立目标；
- Provider Webhook、定时事件或其他 Agent 未携带显式授权的建议。

系统不依赖固定关键词作为唯一判断。语义存在歧义时，Agent 询问“是否创建为目标”，用户肯定后才创建 Draft。Agent 可以建议建立目标，但不能替用户确认。

## 4. TargetCreationDraft

TargetCreationDraft 属于交互上下文层，不是 Target 或 TargetRevision。它是可编辑、可恢复的结构化草稿，至少记录：

- Workspace、Conversation、发起 Principal 和来源 Message；
- 标题与可判定 Goal；
- Outcome Owner；
- Constraints；
- 至少一条 AcceptanceCriterion；
- RiskLevel；
- Deadline，可为空；
- ResourceRefs、Agent/Director 建议和适用 Policy 摘要；
- 可选 Collection 引用；
- 每个字段的来源消息、建议主体和最近修改时间；
- 确认版本、确认 Principal 和幂等命令键。

Collection 只用于可选聚合，不是创建 Target 的前置条件、权限边界或策略真相源。创建时有效的资源、责任和策略必须写入 TargetRevision 或其版本绑定引用，不能依赖 Collection 中的可变信息。

状态固定为：

```text
collecting -> ready_for_confirmation -> converted
     |                  |
     +-> canceled       +-> collecting  (字段发生实质修改)
```

`collecting` 表示仍缺少必需字段或存在歧义；`ready_for_confirmation` 表示系统可以展示完整预览；`converted` 表示幂等命令已创建 Target。Draft 不使用 `accepted`、`active` 或其他 Target 状态。

## 5. 多轮补全与确认

Agent 每轮只询问阻止目标成立的高价值缺口，优先复用 Conversation 已知上下文和 Workspace 默认值，但必须在确认卡片中标明推断值。用户可以随时查看、修改、取消或恢复 Draft。

Target 创建前必须展示结构化确认卡片，至少包含目标、Outcome Owner、验收条件、风险、关键约束、资源范围和可选归类。具备 `targets:create` 权限的人类通过明确确认操作提交创建命令。普通自然语言的继续讨论、Agent 自己的总结以及未映射身份的 Provider 用户都不构成确认。

初始创建请求即使已经包含全部必需字段，也先进入 `ready_for_confirmation` 并展示确认卡片，不静默创建 Target。高风险目标还必须显示适用 Policy 和后续 ActionApproval/Acceptance 责任，但创建确认本身不替代这些决定。

## 6. 创建事务与幂等

确认操作提交 Workspace-scoped `CreateTarget` 命令。命令固定 Draft ID、Draft Version、确认 Message/Action、确认 Principal、完整 TargetRevision 输入和幂等键。服务端重新校验 Workspace 成员、创建权限、Owner、ResourceScope 和 Draft 版本。

同一 Draft Version 的重复确认必须返回同一个 Target 与 TargetRevision。确认后发生字段修改会形成新 Draft Version；旧确认不能作用于新版本。Target 创建成功后，系统原子或可恢复地：

1. 创建 Target 和首个不可变 TargetRevision；
2. 写入 AuditEvent 和 transactional outbox event；
3. 把 Draft 标记为 `converted` 并记录 Target/Revision；
4. 为 Conversation 添加 Target 与 TargetRevision ContextBinding；
5. 向来源 Channel 返回可跳转的目标卡片。

临时失败保留原幂等键和已确认 Draft Version，允许安全重试。任何未知创建结果必须先查询命令 receipt，不能生成第二个 Target。

### 创建成功回信

创建命令与渠道通知是两个独立结果。飞书 Draft 完成转换及 ContextBinding 后，应用服务从同一 Workspace 的事件、来源消息、确认版本、创建命令回执和审计中读取发送依据，核对当前 Connector 配置与用户映射。调用者不能提交收件人、回复正文或送达结论。

`verrail_channel_target_replies` 保存每个 Workspace/Draft 唯一的发送记录及版本、上下文、配置和正文指纹。服务先提交 `sending` 占用及审计，再调用既有 Connector。收到结构有效的 Provider 回复后记录 `succeeded`；异常或无法确认结果时记录 `unknown`。进程中断留下的 `sending` 与 `unknown` 都不自动重发，重复确认只读取已有记录。通知异常不撤销已创建的 Target，也不产生第二个 Target。发送前条件不成立时返回 `blocked`，没有发送占用；Web-only Draft 返回 `not_applicable`。

回复仅包含 Target 链接和 TargetRevision 标识，不包含目标正文。链接源于服务端配置的基础 URL，不采信请求 Host。认证部署未配置基础 URL 时阻止通知；本地受信部署的回退链接仅适用于本机，不代表远端可访问。界面在通知结果未确认时提示警告，并继续打开已创建的 Target。

确认接口在 `target` 之外返回 `channelReply: { status, receiptId }`。`GET /api/workspaces/:workspaceId/conversations/:conversationId/target-drafts/:draftId/channel-reply` 只读回持久状态，不发送消息、不返回 Provider 原始标识；没有匹配记录时返回 `blocked`。读取要求 Board 和 Workspace 访问权限，响应不缓存。

原确认者可以通过 `POST /api/workspaces/:workspaceId/conversations/:conversationId/target-drafts/:draftId/channel-reply/reconcile` 提交唯一字段 `providerMessageId`，请求核实一条已经存在的飞书回信。该字段只是候选引用，不是送达结论。Host 核对当前 Workspace 成员权限、确认版本、来源事件、Connector 配置指纹及用户映射，再通过可选 `handleChannelReplyRead` 读取 Provider 消息。Feishu Connector 只接受本配置应用发送、未编辑且未删除的文本消息；只返回父消息、会话、正文 SHA-256 和 Provider 创建时间，不返回正文或凭证。

Host 要求父消息、会话和正文摘要与原发送占用一致，Provider 时间位于发送开始前 5 秒至开始后 60 秒内，并在读取后复查上下文与配置。成功以条件更新写入 `succeeded` 和独立的 `channel.target_reply.reconciled` 审计，记录观察摘要、原状态和核实方式；授权与确认版本在写事务中再次校验。`sending` 未满 60 秒不启动核实；超过此时间可核实遗留占用。缺少读取能力、权限不足、引用不匹配、配置变化或无法确认时不标成功、不自动重发。旧插件没有该可选 hook 时保持关闭。并发核实有实例内限流，最终持久更新仍使用数据库条件检查。

核实结果沿用 `{ status, receiptId }`，HTTP 响应不缓存，不输出 Provider 标识；非法输入返回 400，越权返回 403，已识别的状态/上下文冲突返回 409。不支持凭人工勾选标为已送达，不提供未知结果的强制补发。核实只恢复通知状态，不生成独立 CriterionProof。

原 Conversation 的已转换草稿提供“渠道回信”入口，打开只读状态与核实对话框，不显示创建或确认目标动作。`unknown` 与 `sending` 状态允许原确认者提交候选飞书消息 ID；有效输入只包含 1 至 200 个字母、数字、下划线或连字符。打开或刷新只查询持久状态，只有显式提交才请求 Provider 核实。服务端决定发送是否仍在保护窗口及调用者是否有权核实。未匹配、权限不足、上下文冲突与服务不可用分别保留可见结果，不自动重试。关闭或切换草稿清空输入；后台旧状态响应不能覆盖核实成功结果。操作员始终可以打开已创建的目标，通知状态不影响目标创建事实。

### 交付上下文读取

`GET /api/workspaces/:workspaceId/delivery-context/channel` 接收 `channelEventId`、`draftRevisionId`、`createdTargetId`、`createdTargetRevisionId`；`GET /api/workspaces/:workspaceId/delivery-context/codex` 接收 `targetId`、`targetRevisionId`、`graphRevisionId`、`runId`、`runAttemptId`、`heartbeatRunId`，并可成对提供 `artifactRevisionId`、`fixedCiProofId` 核对已有固定 CI 与源产物关联。两者仅接收严格的 UUID 引用，在 Board 和 Workspace 访问校验后读取数据库及受控日志，不接收自报事实或通过结论，不登记 CriterionProof。

响应分别保留 `database_context_only`、`execution_context_only` 及未验证项。渠道通知记录是应用送达状态，不是 Provider 真实性或独立回复证明；Codex 上下文也不等于有效权限、固定 CI、工件和运行构建的独立证明。Codex 日志检查有字节和等待上限，读取接口限制并发，所有响应禁止缓存。

## 7. 权限与身份

- Provider 用户必须通过 Connector 身份映射成为 Workspace Human Principal，才能确认创建；
- 未映射用户可以参与普通会话，但不能创建、批准或验收 Target；
- Agent 可以提取字段、提出问题和生成 Draft 建议，不能代表人类确认创建；
- Collection 可见性仅影响可选归类；不选择 Collection 仍可按 Workspace 与 ResourceScope 创建 Target；
- ActionApproval、DeliveryReview 和 Acceptance 保持独立授权，不能由创建确认替代。

## 8. 产品表现

Chat 是创建目标的主入口。全局 `New Target` 命令打开或创建 Conversation，并发送结构化“开始创建目标”意图，而不是展示要求用户一次填完全部字段的长表单。

草稿在会话中使用可检查对象呈现，显示缺失字段、当前版本和下一步操作。创建成功后显示 Target 链接，并允许继续在同一 Conversation 讨论该 Target；后续普通消息不会创建新的 Target，除非用户再次明确启动创建流程。

创建产生的 Target/TargetRevision ContextBinding 保存来源关系，不代表永久聚焦。会话没有当前目标且上下文版本未被并发修改时，成功创建后聚焦该目标；会话已有当前目标时保留原选择，并提供“围绕新目标继续”。创建重放或通知重试不再次切换上下文。用户可以手动切换或通过明确会话意图让 Director 切换、清除当前目标，不因此改变已确认 Draft、Target 或提案的归属。完整上下文与权限规则见 `product-design.md` 的 Conversation 定义。

Target 列表直接属于 Workspace。Collection 只作为可选筛选、保存视图和批量聚合，不出现在 Target 的必选面包屑中。

## 9. 验收标准

1. 普通群聊、私聊和 Web Chat 消息不会创建 Target 或 TargetCreationDraft；
2. 明确创建意图只创建 Draft，并可在服务重启后继续补全；
3. 必需字段不完整时不能提交 CreateTarget；
4. 完整草稿在授权人确认前不会创建 Target；
5. 同一 Draft Version 重复确认只产生一个 Target；
6. 一个群聊中并发草稿不会串联消息或互相覆盖；
7. 无 Collection 的 Target 可以创建、读取、执行和验收；
8. Collection 被归档或修改不会改变已创建 TargetRevision 的责任、资源或策略；
9. Provider 身份未映射、权限不足、Owner 无效和资源越界均失败关闭；
10. 创建后 Conversation、Target、TargetRevision、AuditEvent 和 outbox 具有可追溯引用。

## 10. 非目标

- 不把 Verrail 建设为脱离 Agent、Target 和治理对象的通用聊天产品；
- 不把每次 Agent Run、一次性问答或普通消息升级为 Target；
- 不允许 Agent 仅凭推断创建、批准或验收目标；
- 不依赖 Project 才能获得 Workspace、权限、资源或策略上下文；
- 不用 Provider 消息记录替代 PostgreSQL 中的 Target 与审计事实。
