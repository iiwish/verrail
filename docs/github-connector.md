# GitHub Connector 执行合同

版本：0.3

状态：`Confirmed`

最后更新：2026-09-27

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
- commit binding 是完整的 40 位小写 Git SHA，head 是绑定仓库内的分支；
- GitHub repo binding 和 credential connection 仍有效且属于同一 Workspace。

任一检查失败时，Provider API 不会被调用。

已执行命令的重放返回历史 EffectReceipt 前，必须通过当前有效连接重新读取 GitHub PR，并校验同一个外部对象、head SHA、head/base 仓库和分支。历史 Receipt 不会被重写；它记录创建时的事实，不授予当前 Submission 新的 Acceptance。

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

每次执行首先按 repo 和 marker 查询 open/closed Pull Request。查询不按可变的 head/base 过滤，避免已创建 PR 被 retarget 后误判不存在：

- `found`：不调用 create；仅当实际 head SHA、head/base 仓库和分支与已批准参数及已验收 Commit 一致时提交唯一 EffectReceipt；
- `absent`：当前执行持有创建权时，先读取 `git/ref/heads/{branch}`，校验分支实际 HEAD 等于已验收 Commit，才可以调用 create；
- `inconclusive`：保持或进入 `unknown_effect`，不调用 create。

活动 `executing` 状态在两分钟内只允许其他请求查询，不允许第二次 create。超时的执行可以重新取得创建权，但仍必须先 lookup。Provider timeout、连接重置、成功后响应丢失和 Effect 后数据库提交失败都进入同一对账路径。

一旦取得外部 PR number，系统在写入成功 Receipt 前独立提交 Provider Observation 审计。后续恢复按该固定 number 读取，而不依赖可编辑的 body marker。已执行重放也直接读取 Receipt 固定的 PR number。已知 PR 被删除、不可读或版本不匹配时不得重新创建；历史 Receipt 保持不变。没有取得任何外部对象身份的未知结果仍采用有界 marker 查询，不能对任意外部改写提供 exactly-once 保证。

`verrail_effect_receipts` 对 `action_request_id` 和 `provider_marker` 都有唯一约束。Receipt 保存外部对象 ID、URL、参数摘要、marker、effect hash，以及实际观察到的 head SHA、head/base 仓库和分支，不保存凭证。创建响应、marker 对账和重放都检查 Provider 的实际版本，缺失字段不得视为匹配。

创建或对账发现版本不匹配时，ActionRequest 保持 `unknown_effect`，审计保存预期 Commit 和实际 PR 身份，不生成成功 Receipt，不重置为可盲重试的批准状态，也不自动关闭 PR 或改写分支。已执行 Receipt 的重放发现漂移时返回冲突并追加审计，保留历史 Receipt。

GitHub 的创建 PR API 不接受原子 expected-head 条件。前置读取和创建响应校验能拒绝错误版本的成功回执，但不能防止两次 API 调用之间短暂创建了错误版本的 PR，也不能保证远端分支之后永远不移动。发布操作须再次校验当前 HEAD、受验 SHA 与批准版本；需要持续不可变保证时，Operator 必须另外限制候选分支写入。

## 6. GitHub 查询边界

查询使用 GitHub Pull Requests API 的 `state=all` 和分页结果，并在 body 中匹配完整 marker。找到后逐项核验 head/base，仓库名按 GitHub 的大小写不敏感规则比较，分支名保持大小写敏感。查询错误、响应解析失败或超过有界分页上限均为 `inconclusive`，不得解释为 `absent`。

真实生产验收需要一个可写测试仓库、已推送且固定的 head branch、预期 base branch，以及仅限该仓库的短期凭证：Pull requests 读写、Contents 只读，采集 CI 时另需 Actions 只读，Metadata 为必需只读权限。真实 PR reference 和脱敏的无凭证持久化证明属于 G2.7 最终验收证据，不由 fake connector 测试替代。

## 7. 固定 CI Observation 采集

`POST /api/workspaces/:workspaceId/targets/:targetId/github-ci-observations` 只接受严格 JSON：

```json
{ "runId": "123", "runAttempt": 2 }
```

`runId` 是不含前导零的正整数数字字符串，数值不超过 JavaScript safe integer；`runAttempt` 为 `1..2147483647` 的整数。请求不能携带 SHA、Policy、Artifact 声明、凭证、Principal、verdict 或 assertion。成功返回 `201 GithubCiObservationReceipt`，不需要 `Idempotency-Key`；每次采集都是单独审计的读取，不是幂等领域写命令。

路由使用现有认证中间件的实际非空 `userId` 与 `source`，不使用缺省 `board` 身份或伪造 Session。非本地 Board 用户必须有活动、非 viewer 的 Workspace 成员关系，包括 instance admin；Agent 与匿名请求不能调用。现有 `local_trusted` 中间件产生的 `local-board` / `local_implicit` 身份可以使用此入口，但仍须显式列入采集 Policy，且不代表一个具名真人或独立人类治理决定。成员关系、操作者授权和版本上下文在读取凭证前检查。

生产路由的 `connectorRoutes({ db })` 直接组合 Collector、现有 Workspace Secret resolver、GitHub REST/download adapter 和 ZIP reader。默认未配置 Policy 时返回 `503`，不读取秘密或访问网络。GitHub authorization 只保留在一次采集的闭包中，不交给 Agent、Go Domain API、请求 body 或持久化记录。

### Operator-owned Policy

`VERRAIL_GITHUB_CI_POLICIES` 是 Operator 配置的严格 JSON 数组，最多 64 个条目、128 KiB；每个 Workspace/Target 只能有一个条目，每条最多 32 个唯一授权用户。未知字段、重复或含混条目、非法 Hash/ID、超预算配置均拒绝。配置只授权 Observation 采集，不授予 Acceptance、CriterionProof 或可变验证器信任。

以下是完整结构模板，其中尖括号值必须由 Operator 替换为经过独立审核的真实固定值；模板本身不能启用采集。两个标注为 numeric ID 的字符串必须替换为正 safe integer JSON 数字。不得从当前目录、Agent 产物文本或待验报告猜测这些值。

```json
[
  {
    "workspaceId": "<workspace UUID>",
    "targetId": "<target UUID>",
    "targetRevisionId": "<current target revision UUID>",
    "graphRevisionId": "<active graph revision UUID>",
    "connectionId": "<active enabled GitHub connection UUID>",
    "bindingId": "<repository binding UUID>",
    "authorizedUserIds": ["<authenticated user ID>"],
    "policy": {
      "repository": "<owner>/<repository>",
      "repositoryId": "<numeric repository ID>",
      "workflowId": "<numeric workflow ID>",
      "workflow": {
        "path": ".github/workflows/verrail-candidate-verify.yml",
        "sha": "<40 lowercase hex workflow execution SHA>",
        "sha256": "<64 lowercase hex workflow source SHA-256>"
      },
      "helper": {
        "path": ".github/scripts/verrail-candidate-proof.mjs",
        "sha256": "<64 lowercase hex helper source SHA-256>"
      },
      "requiredJobs": [
        { "name": "candidate_verify", "steps": ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", "ts_tests", "ts_typecheck", "ts_build", "go_tests", "source_unchanged", "capture_results"] },
        { "name": "candidate_report", "steps": ["checkout", "setup_node", "report", "upload"] }
      ],
      "artifactDownloadHosts": ["<operator-reviewed exact public download hostname>"],
      "maxAgeMs": 86400000,
      "timeoutMs": 30000,
      "maxPages": 3,
      "maxResponseBytes": 1000000,
      "maxArchiveBytes": 1000000,
      "maxReportBytes": 100000
    }
  }
]
```

全部预算为正整数；上限分别为 7 天有效期、120 秒、20 页、2,000,000 字节响应、10,000,000 字节压缩包与 1,000,000 字节报告。只支持同仓库 `push` 到 `codex/g2-7-candidate-*` 分支的固定工作流，Workflow execution SHA 同时固定受验 candidate SHA；这是显式 v1 限制，不是从 caller SHA 推断的身份等价。

采集读取同 Workspace 当前 TargetRevision、活动 GraphRevision、repo binding、活动启用的 connection 和引用 Secret 的版本元数据。连接可以是已绑定的 GitHub MCP connection；其 credential 只由现有 resolver 解析，本入口仍使用独立、固定 origin 的 REST adapter，不把 MCP transport 或 URL 当作任意 REST 代理。Policy 固定身份必须与数据库匹配；凭证解析后及 Provider 读取后再次检查上下文。目标修订、图、重绑定、连接禁用或 Secret rotation 等冲突不会返回成功回执。Secret 的 `updatedAt` / `lastResolvedAt` 属于 resolver 正常访问记账，不计入漂移指纹；Secret 版本、轮换、撤销与 Provider 配置安全元数据仍受检查。网络读取期间不持有长数据库事务。

### 传输与审计

认证请求只允许 `GET https://api.github.com` 下固定仓库的精确 Attempt、jobs、artifacts、固定 source contents，以及精确 SHA 的 Git commit 和非递归 root tree 端点；不跟随带凭证的重定向，不接受 caller URL 或 header。Git 对象端点仅供受验提交到源码快照的映射，不授予 Agent 通用仓库读取权限。Artifact 下载使用独立无凭证 HTTPS transport、Operator 审核的精确主机白名单和手工重定向策略。分页、总超时、响应体、压缩包与解压流均受预算限制。ZIP 使用直接固定依赖 `yauzl 3.4.0`，只接受一个普通 `verrail-fixed-ci.json` 文件，不解压到磁盘；支持普通 ZIP 的 store/deflate 与 12/16-byte data descriptor，拒绝 ZIP64、archive comment、前置或尾随额外记录、路径穿越、目录、链接、加密、非法压缩或截断内容。生产归档兼容性需要真实 Provider 验证，合成 ZIP 测试不替代这项验证。

进程内并发和速率保护在 Secret 读取前执行：全进程最多 4 次并发采集，每个 Workspace/Target 键最多 1 次并发、每分钟最多 4 次启动，最多保留 256 个键；所有退出路径释放并发占用。该保护仅属于当前 Node 进程，不是跨副本租约、持久化恢复、全局配额或 exactly-once 保证；多副本部署须另设入口限流。进程重启不能恢复该内存计数。

成功回执固定 Workspace/Target/Revision/Graph/Connection/Binding、Policy SHA-256、`auditEventId` 与来源 Observation。现有 `logActivity` 保存实际发起用户、来源、独立命名的确定性 verifier、版本绑定、Hash 和脱敏 Observation；必须成功持久化审计才能返回成功。回执、审计和错误不包含凭证、原始配置、原始报告、压缩包、日志或签名下载 URL。输入错误返回 `400`，身份或授权拒绝返回 `401/403`，上下文缺失或冲突返回 `409`，进程限流返回 `429`，Provider/报告验证失败返回 `502`，禁用、凭证或内部依赖不可用返回 `503`。

### 证明边界

Observation 只验证 `ts_tests`、`ts_typecheck`、`ts_build` 与 `go_tests` 的固定 CI 事实和来源 Hash。它不是 CriterionProof，不证明 ArtifactRevision 与受验 Commit 等价，也不创建 IntegrationRun、Evidence、VerificationResult，或修改 Graph/Acceptance/Outcome。完整入库仍要求不可变验证器信任、当前来源与产物映射、版本绑定和完整 compound all-of 覆盖。

通用 IntegrationRun 入口拒绝显式 proofContract 证明，包括持有内部 bearer 的 service Principal 和历史命令重放。`auditEventId`、Observation receipt 或调用方填写的 `criterionProof` 不是证明授权令牌。未声明 proofContract 的兼容集成记录保持原有行为，但不授予显式证明能力。显式固定 CI 证明使用下述单独准入路径，不能将 Observation 回执上传到通用入口进行升级。

`live_feishu`、`live_codex`、`live_recovery`、`secret_non_persistence`、`human_governance`、`pr_effect` 明确列为不支持的义务。CI 成功不能替代真实 Channel、Agent、恢复演练、秘密不落盘、独立真人决定或真实 PR Effect，也不能据此宣布 G2.7 完成。

## 8. 固定 CI 证明准入与源码映射

`POST /api/workspaces/:workspaceId/targets/:targetId/github-fixed-ci-proofs` 要求 `Idempotency-Key`，只接受严格 JSON：

```json
{
  "runId": "123",
  "runAttempt": 2,
  "claimId": "<existing Claim UUID>",
  "workNodeId": "<IntegrationTask UUID>",
  "artifactRevisionId": "<native source snapshot ArtifactRevision UUID>",
  "requirementId": "<existing proof requirement ID>"
}
```

请求只选择已有事实。Criterion 由 Claim 推导，版本、仓库和受验 SHA 由经过固定的配置与当前领域事实确定；调用方不能填写证明结论、断言覆盖、对象 Hash、verifier 身份或旧 Observation。身份、成员资格、显式用户白名单和进程限流与 Observation 采集共用同一边界。

### 启用条件

默认不启用证明能力。Operator 必须显式配置相互独立的 `VERRAIL_GITHUB_CI_PROOF_TOKEN` 与 `VERRAIL_GITHUB_CI_PROOF_TRUST`。两者均未配置时路径不可用；只配置一项、非法配置或与普通 `VERRAIL_DOMAIN_API_TOKEN` 相同的 token 均失败关闭。系统不生成 verifier 凭证或默认授信。配置由进程启动时固定，撤销或更换需要更新配置并重启相关进程。

这两项配置只交给 Node 控制平面和 Go Domain API，不能放入 Agent 配置、项目环境文件或候选仓库。Agent、工作区服务和 ACPX terminal 子进程的最终环境删除普通领域 token 与 proof token，包括大小写变体和 ACPX 认证别名；Codex、Pi 和 OpenCode 的 Provider 环境占位符不能将它们展开为运行配置。ACPX 的会话环境在持久化前清理，最终子进程过滤由仓库固定的 ACPX patch 保证。运行级 Agent API key 和模型凭证保持各自既有权限。这是凭证继承与配置展开边界，不是 HostTrusted 同权限进程隔离，也不清理历史环境或运行文件。

`VERRAIL_GITHUB_CI_PROOF_TRUST` 是单个严格 JSON 对象，不接受数组或通配符：

| 字段 | 固定内容 |
| --- | --- |
| `schemaVersion` | `1` |
| `workspaceId`, `targetId`, `targetRevisionId`, `graphRevisionId` | 精确领域版本 UUID |
| `connectionId`, `bindingId` | 活动 GitHub 连接与仓库绑定 UUID |
| `policySha256` | 已解析的完整 CI Policy 条目的 SHA-256，包括授权用户与预算 |
| `repository`, `repositoryId`, `workflowId` | 精确仓库名称及 Provider 数字身份 |
| `workflowExecutionSha` | 受验候选与工作流执行的同一个 40 位小写 Git SHA |
| `workflowSha256`, `helperSha256` | 固定工作流和 helper 源文件 SHA-256 |
| `maxAgeMs` | Provider 完成时间的有效期，正整数且不超过 7 天 |

`policySha256` 使用既有严格 Policy parser 的字段顺序，对 `JSON.stringify(parsedEntry)` 计算 SHA-256；Go 将其作为精确固定摘要，不使用 Go JSON 序列化重新计算该字段。授信还固定工作流、helper、源码范围和代码拥有的 verifier 版本；配置不能自定义断言映射或授予真人决定权。

### 验证与持久化

读取秘密或访问 Provider 前，系统检查所选义务为 `pre_acceptance` 的 `independent_verification`，且非空断言集合完全包含于 `ts_tests`、`ts_typecheck`、`ts_build`、`go_tests`。复合自然语言义务、后置义务或不支持的断言直接拒绝，不降级、不拆写已接受的合同。

源码产物必须由原生 `verrail-host-runner` 成功执行登记。系统沿 ArtifactRevision 的来源 Run/WorkNode、登记审计、Attempt/fencing 和权威 succeeded RunEvent，读取不可变事件中的已定稿 v2 output receipt，并校验精确 `source_snapshot` 项的 Hash、引用、顺序和身份。普通文件、人工补建产物、旧版回执、缺失来源和历史重标不能建立这条关联。

服务在一次受限凭证会话中执行真实固定 CI reader，再读取该受验 Commit 的 Git root tree。隔离的 Git plumbing 重建完整 root tree 并验证其 SHA，拒绝截断、缺失或非法条目；只去除根目录名为 `.verrail` 的条目后重建产品源码 tree，要求其与可信快照的 `snapshotTree` 相等。Git 的递归 tree 身份绑定所有保留的子树与 blob；不需要下载仓库历史或 checkout。嵌套目录中的 `.verrail` 不排除。

该映射证明 v2 产品源码范围内的 Git tree 身份，不证明完整 Commit 相等、运行时构建来源、有效权限、秘密扫描或同权限恶意进程隔离。未提交和未跟踪的快照内容只有进入受验候选 Commit 后才能匹配。源码、连接、秘密版本、Policy 与当前图在 Provider 读取后再次检查。

内部 `POST /v1/workspaces/:workspaceId/github-fixed-ci-proofs` 只接受专用 proof bearer，不接受调用方 Principal header；普通领域 token 不能调用该入口，proof token 不能调用普通领域命令。Go 在同一事务中重新校验授信、当前版本、Claim、IntegrationTask 和精确来源关联，再处理命令重放。结论、内容 Hash、断言覆盖与 verifier 身份由服务构造，IntegrationRun、IntegrationAttempt、Evidence、VerificationResult、CriterionProof、审计与节点变化原子提交。相同 Provider Attempt 不得用新命令键改写来源或提升为不同证明。

成功返回 `201`，相同事实重放返回 `200`，资源类型均为 `integration_run`。这条固定 v1 路径只接收 reader 完整验证成功的结果；Provider 失败、不可用或映射不符不产生证明，也不伪造 failed/neutral 结果。既有证明的有效期、版本变化和后续负向验证生命周期仍须按完整领域合同处理。发起用户的采集审计与 verifier service 的领域审计保持独立，均不等同于真人 Review、Acceptance 或 ActionApproval。

采集审计的组件名为 `verrail/github-fixed-ci-reader/v1`；领域证明固定 service Principal `github-fixed-ci-verifier` 和版本 `github-fixed-ci-verifier.v1`。源码信任依赖原生 runner 的可信事件入口和不可变存储关联；映射不重新下载 Artifact 字节，也不能防御已被攻破的内部领域服务通道或宿主机。
