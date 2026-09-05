# GitHub Connector 执行合同

版本：0.1

状态：`Confirmed`

最后更新：2026-09-04

## 1. 目的

GitHub Connector 把经过人类批准的 `create_pull_request` ActionRequest 转换为一个可对账的外部 Effect。PostgreSQL 保存 ActionRequest、ActionApproval、稳定 Provider marker、执行状态和唯一 EffectReceipt；GitHub 保存实际 Pull Request。任何重试都先查询 GitHub，再决定是否允许创建。

## 2. 凭证边界

TypeScript facade 在收到已认证的人类执行命令后，从 Workspace 绑定且启用的 `tool_connections` 连接即时解析 GitHub 凭证。Secret Service 记录不含值的访问审计。Facade 只在本次已认证内部请求中发送以下 header：

- `X-Verrail-GitHub-Connection-Id`
- `X-Verrail-Ephemeral-GitHub-Authorization`

Go Domain API 使用独立的 `Authorization: Bearer <domain-api-token>` 验证内部调用。GitHub 凭证不属于领域命令，不进入 JSON body、command receipt、AuditEvent、outbox、Temporal payload、EffectReceipt 或日志。Go 在请求完成后不保留凭证。

连接在执行时必须仍属于同一 Workspace、状态为 `active`、已启用，并与 facade 发送的连接 ID 一致。当前解析器支持 `Authorization` header credential ref，以及 `oauth.access_token`、`credentials.token`、`github.token`、`access_token` 或 `token` secret ref。当前边界只读取连接中可用的 access token；过期 token 会由 GitHub 拒绝并保持可重试状态，Connector 不执行自动刷新，也不持久化刷新令牌或 GitHub App installation token。

## 3. 权限与固定输入

ActionRequest 可以由已认证的 Agent、Service 或人类发起。ActionApproval 和执行命令必须由已认证的人类 Workspace 成员提交。发起者是人类时，批准者必须是另一个人；Agent 或 Service 发起时，一个 Outcome Owner 可以依次执行 Review、ActionApproval 和 Acceptance，但这些决定保持独立命令和独立事实。

每次执行和对账都重新检查：

- ActionApproval 存在、批准者身份有效且 `params_hash` 完全匹配；
- ActionRequest 中的 `title`、`head`、`base`、`body` 重新计算后仍匹配 `params_hash`；
- Submission 仍是 Target 的最新 Submission；
- Submission 的 TargetRevision 仍是活动 Revision；
- Outcome Owner Acceptance 仍存在并绑定同一 Workspace、Target 和 TargetRevision；
- ActionRequest 固定的 `expected_commit_ref` 仍等于不可变 Submission 的 commit binding；
- GitHub repo binding 和 credential connection 仍有效且属于同一 Workspace。

任一检查失败时，Provider API 不会被调用。

## 4. Provider marker 与状态机

Provider marker 是以下内容的 SHA-256：

```text
github:create_pull_request:{actionRequestId}:{paramsHash}
```

创建请求把 marker 写入 Pull Request body 的 HTML comment：

```text
<!-- verrail-effect:{providerMarker} -->
```

ActionRequest 可以携带最长 65,536 字符的 Pull Request 正文。正文属于审批参数，任何修改都会改变 `params_hash` 并使旧批准失效。Connector 在正文末尾追加且只追加一次 provider marker；未提供正文的旧调用保持兼容并只写 marker。

ActionRequest 状态机为：

```text
pending_approval -> approved -> executing -> executed
                                  |
                                  +-> unknown_effect -> executing
                                  |
                                  +-> approved        (确定未产生 Effect 的 Provider 拒绝)
```

`executing`、`unknown_effect` 和 `executed` 必须持有 64 位 marker。执行在提交 `executing` 后释放数据库事务，再访问 GitHub。GitHub 网络调用期间不保持数据库事务。

## 5. Lookup-before-retry

每次执行首先按 repo、head、base 和 marker 查询 open/closed Pull Request：

- `found`：不调用 create，直接提交唯一 EffectReceipt；
- `absent`：当前执行持有创建权时可以调用 create；
- `inconclusive`：保持或进入 `unknown_effect`，不调用 create。

活动 `executing` 状态在两分钟内只允许其他请求查询，不允许第二次 create。超时的执行可以重新取得创建权，但仍必须先 lookup。Provider timeout、连接重置、成功后响应丢失和 Effect 后数据库提交失败都进入同一对账路径。

`verrail_effect_receipts` 对 `action_request_id` 和 `provider_marker` 都有唯一约束。Receipt 只保存外部对象 ID、URL、参数摘要、marker 和 effect hash，不保存凭证。

## 6. GitHub 查询边界

查询使用 GitHub Pull Requests API 的 `state=all`、固定 head/base 和分页结果，并在 body 中匹配完整 marker。查询错误、响应解析失败或超过有界分页上限均为 `inconclusive`，不得解释为 `absent`。

真实生产验收需要一个可写测试仓库、已推送且固定的 head branch、预期 base branch，以及具备 Pull Request 创建和读取权限的短期凭证。真实 PR reference 和脱敏的无凭证持久化证明属于 G2.7 最终验收证据，不由 fake connector 测试替代。
