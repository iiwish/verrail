# G2.7 交付证据与领域不变量差距矩阵

Version: v1.0
Status: Completed
Task: T001
Attempt: T001-A001
Base commit: `b46307dbd05a912c38a32395b88662952286fd58`
Observed at: 2026-09-04T03:22:33Z

## 判定规则

- **implemented**：当前源码和可检查证据共同证明合同已存在；不等同于目标已获真人验收或已发布。
- **partial**：部分层次或测试存在，但端到端事实、权限、恢复、UI 或生产证据仍缺失。
- **missing**：当前源码、运行时和交付记录均不能证明要求成立，或明确记录为 deferred。
- 测试 fixture、Fake Connector、手工 seed、Agent 自述和 Timeline 摘要不能替代真实生产验收。

## 审计输入

- 仓库：`/Users/iiwish/self/verrail`
- 分支：`codex/g2-7-production-closure`
- HEAD：`b46307dbd05a912c38a32395b88662952286fd58`
- 规范：`docs/product-goals.md`、`docs/operational-ontology.md`、`docs/architecture.md`
- 目标记录：3 个 G1、7 个历史 G2 目标和当前 G2.7，共 11 个 `target.json` 与 11 个 `timeline.jsonl`
- 运行时：`http://localhost:3100`，健康状态 `ok`，服务 commit 与 HEAD 一致
- 外部合并事实：GitHub PR #2 至 #13 均通过 `gh pr view` 查询；与本矩阵相关的 #2、#7、#10、#11、#12、#13 均为 MERGED

## 当前基线结论

领域模型重构**尚未完成**。当前仓库已经具备原生 Workspace/Target/Revision/Graph/Run、版本化
Agent、Artifact/Evidence、Submission/Review/Acceptance 和 GitHub Action 的主要数据与命令骨架，
但仍缺 IntegrationAttempt、HumanWorkResult、完整 IntegrationRun 版本绑定、主动 Graph/Temporal
协调、单真人可用的 Agent/Service 候选身份、GitHub Secret 桥接、UnknownEffect 对账、飞书通道
和完整 UI 命令面。运行时没有任何可仅由 PostgreSQL 重建的 accepted Target，也没有真实 GitHub
EffectReceipt。

## 历史目标一致性

| Target | 本地状态 | 仓库/评审证据 | 当前运行时 | 判定 |
| --- | --- | --- | --- | --- |
| `g1-brand-nav-foundation` | `needs_review` | 3 receipts、3 evidence、2 advisory reviews；PR #2 merge `ddd8f8a0` 在 HEAD | 无 runtime identity | 状态诚实；代码已合并，但无最终真人验收或 ship record |
| `g1-frontend-productization-closure` | `needs_review` | 1 receipt/evidence/advisory review；PR #7 merge `910780c9` 在 HEAD | 无 runtime identity | 状态诚实；记录明确缺 dedicated Playwright 与最终真人评审 |
| `g1-domain-closure` | `needs_review` | 4 receipts/evidence、2 self reviews；G2.0 独立评审判定 SATISFIED；PR #10 merge `c4d2ae2f` | 当前 DB 无历史 Workspace；`target.json` 的 runtime Target 与 run-003 live acceptance Target 不同 | 实现已合并，真人验收未记录；runtime lineage 需要对账 |
| `g2-0-stabilize-g1-baseline` | `needs_review` | run-001 receipt、2 evidence、maintainer + independent review；PR #10 | 历史 Workspace `74170eed` 已不在当前 DB | 状态诚实；run-002 缺 receipt |
| `g2-1-versioned-agent-lifecycle` | `needs_review` | receipt/evidence/maintainer review；合并独立评审判定 SATISFIED；PR #10 | 历史 Workspace `45571f9e` 已不在当前 DB | 实现已合并，真人验收未记录；当前无法重放原 runtime identity |
| `g2-2-recoverable-run-execution` | `needs_review` | receipt/evidence/maintainer review；合并独立评审判定 SATISFIED；PR #10 | 历史 Workspace `45571f9e` 已不在当前 DB | evidence 的“缺 independent review”已被后续合并评审补足，但没有交叉引用 |
| `g2-3-artifact-evidence-contracts` | `accepted` | evidence + maintainer/independent review；无 receipt；PR #11 merge `5162c89a` | Target 存在但 active revision 与记录不同，当前 assurance facts 为 0 | 本地 slice acceptance 有记录；runtime revision/facts 已漂移，不能作为当前闭环证据 |
| `g2-4-submission-acceptance` | `accepted` | evidence + independent review；无 receipt；PR #11 | Target 为 `draft`；1 artifact/claim/evidence/result/submission，0 review/acceptance | feature slice 已验收；产品内 Review/Acceptance 从未完成，二者不可混称 |
| `g2-5-github-connector-ci-evidence` | `accepted` | evidence + independent review；无 receipt；PR #12 merge `f387757e` | Target 为 `draft`；1 ActionRequest，0 EffectReceipt | 其 spec 明确允许 Fake 并延后真实 GitHub；不能作为 G2 生产闭环证据 |
| `g2-6-loop-verification` | `in_progress` | evidence；timeline 声称 independent review 和 `needs_review`；review 文件与 receipt 均缺；PR #13 merge `b46307db` | Target 为 `draft`；runtime 4 条 AC，本地记录 5 条；无 Acceptance/EffectReceipt | 明确记录漂移：target status、review 引用和 runtime spec 不一致 |
| `g2-7-production-closure` | `in_progress` | Confirmed spec/plan/work graph，T001 packet | Target 为 `draft`，0 Run/Artifact/Evidence/Submission/Review/Acceptance/Effect | 当前状态诚实；生产闭环尚未开始 |

## G2.7 Acceptance Criteria 覆盖

| AC | 状态 | 当前证据 | 关闭差距 |
| --- | --- | --- | --- |
| AC-01 交付事实对账 | partial | 历史记录、merge commit 和当前 runtime 已盘点 | T002 修复 stale status、缺 receipt、断链 review 与 runtime lineage |
| AC-02 Web Chat + 企业通道创建 | partial | Web Conversation/Draft/Confirm 存在并曾现场验证 | 飞书 Channel Connector、webhook 安全、会话绑定与回复缺失 |
| AC-03 固定版本的真实 Codex 执行 | partial | Run/RunAttempt 固定 AgentVersion、DeploymentRevision、GraphRevision；fencing 已验证 | 没有 G2.7 的真实 Codex Run、Environment identity、成本、权限和 CodeChange Artifact 全链 |
| AC-04 持久 Graph/Temporal 编排 | partial | Workflow 有稳定 ID、Signal、Query、去重、Continue-As-New | 没有 Activity、Child Workflow、Timer、依赖节点推进和 Gate 协调 |
| AC-05 完整工作结果合同 | partial | RunAttempt、IntegrationRun 存在 | IntegrationAttempt、HumanWorkResult 缺失；IntegrationRun 未固定 ConnectorVersion、Connection、GraphRevision、Commit、Criterion、Provider Receipt |
| AC-06 独立 assurance 与 acceptance | partial | Artifact/Evidence/Verification/Submission/Review/Acceptance 命令与不变量测试存在 | Submission/ActionRequest 固定为 user，当前单真人 runtime 无 Review/Acceptance 事实 |
| AC-07 安全真实 GitHub Effect | missing | Fake connector 和 thin REST client 存在 | Secret 解析、真实 PR、EffectReceipt、UnknownEffect 和 lookup-before-retry 均无生产证据 |
| AC-08 失效强制执行 | partial | TargetRevision/latest Submission、approval params hash 在 Go/read model 有测试 | G2.7 全链中 artifact/verification/action 变化后的 UI 阻断与真实 Effect 前复核未证明 |
| AC-09 产品 UI 闭环 | partial | Workbench 可读事实，可启动/重试/取消 Run | Submission、Review、Acceptance、Action Approval/Execution 和恢复写操作缺失；飞书缺失 |
| AC-10 故障恢复 | partial | Run fencing、outbox freeze、Worker kill/restart 有证据 | 主动 workflow、Runner、API 和 Provider UnknownEffect 联合恢复未证明 |
| AC-11 Release gate | missing | 历史 focused/full tests 与 merged PR 存在 | 没有覆盖当前 G2.7 的全量 gate、真实 Provider、独立 review 和 Outcome Owner acceptance |

Coverage count: `implemented=0`, `partial=9`, `missing=2`。

## 系统不变量覆盖

| # | 状态 | 证据或差距 |
| --- | --- | --- |
| 1 Workspace 唯一归属 | implemented | 原生表普遍带 `workspace_id` 与复合 FK；跨 Workspace 负例已有 DB/Go 测试 |
| 2 Target 变化形成新 Revision | implemented | `verrail_target_revisions` 不可变、按 Target 单调编号并由 active revision 指向 |
| 3 各类执行固定版本身份 | partial | Agent Run/Attempt 已绑定版本；IntegrationRun 绑定不足，HumanWorkResult 不存在 |
| 4 Active GraphRevision 与 Submission 不原地修改 | implemented | Graph revision 快照与 Submission append-only/immutable 合同已有约束和测试 |
| 5 Graph Engine 唯一裁决、Temporal 只驱动命令 | implemented | Go Domain API 为写 Owner；workflow 当前不直接写业务表 |
| 6 节点类型使用不同完成事实 | partial | Agent/Integration 已分离；IntegrationAttempt 与 HumanWorkResult 缺失 |
| 7 外部 Effect 经 ActionRequest、幂等和 Receipt | partial | ActionRequest/Approval/EffectReceipt 合同存在；不确定结果状态和真实 Effect 缺失 |
| 8 五类授权不合并 | partial | 命令对象分开；Submission/ActionRequest 发起身份被写死为 user，单真人闭环受阻 |
| 9 证明和决定绑定 Hash | partial | Evidence、VerificationResult、Submission、Review、Acceptance 和 Approval 有 hash；完整 Criterion/Connector/Provider 绑定不足 |
| 10 输入变化使旧决定失效 | partial | TargetRevision、latest Submission 与 params hash 已覆盖；端到端 artifact/verification 失效未证明 |
| 11 Runner/Temporal/Transcript 非事实源 | implemented | PostgreSQL read model 和领域命令保持权威，历史 evidence 也明确该边界 |
| 12 Worker/Runner 不绕过领域服务 | implemented | 当前 Worker 只 Signal；执行推进走 Go commands |
| 13 旧 Lease 不覆盖新 Attempt | implemented | G2.2 stale-fence 现场与测试证据存在 |
| 14 Secret 明文不持久化 | partial | 当前真实 GitHub 调用因 credential 缺失而 fail closed；临时桥接和 sentinel 扫描尚未实现 |
| 15 UnknownEffect 先核验再重试 | missing | 当前 GitHub 调用在事务内执行，Provider 成功后事务失败会失去结果，且无 lookup 合同 |
| 16 accepted Target 可从 PostgreSQL 重建 | missing | runtime 中没有 accepted Target；Target status 仍停在 draft，当前无完整 Acceptance 事实链 |
| 17 Timeline/Attention/Outcome 为可重建投影 | partial | read model 读取原生事实，但状态/Attention/Outcome 尚未完整收敛 |
| 18 团队可信记忆只来自 accepted Submission | missing | 当前未实现团队可信记忆晋升边界；属于 G5，但仍是未落地不变量 |
| 19 Conversation 不替代领域事实 | implemented | Message/Binding/Draft 与 Target 命令分离 |
| 20 普通消息不创建 Draft，明确意图经真人确认 | implemented | Web Chat 路径和测试存在；飞书覆盖属于 AC-02 的剩余入口工作 |
| 21 Target 直属 Workspace，Collection 可空 | implemented | schema、Go command、read model 与测试均已覆盖 |
| 22 Workspace 唯一默认 Deployment 且保留实际身份 | partial | 唯一默认约束和 Run 固定身份存在；Conversation 仍走兼容默认 Agent，未证明统一的 Deployment 身份链 |

Invariant count: `implemented=10`, `partial=9`, `missing=3`。

## T002 允许修复的确切记录

1. 将 `g2-6-loop-verification/target.json` 从 `in_progress` 对账为 `needs_review`，时间以现有
   timeline 的完成事件为准；不得提升为 `accepted`。
2. 为 `g2-0` run-002、`g2-3`、`g2-4`、`g2-5`、`g2-6` 补齐**明确标注为回溯重建**的
   receipt，来源只能是已存在 evidence、timeline、Git commit 和 GitHub merge facts。
3. 给 `g1-domain-closure`、`g2-1`、`g2-2` 追加对 `g2-0` combined independent review 的
   交叉引用；不改写原 evidence，不推断用户 acceptance。
4. 对 G1/G2.0/G2.1/G2.2 已消失的历史 Workspace 和 runtime Target 追加
   `runtime_unavailable_in_current_database` 事实；不得把 404 解释为历史运行失败。
5. 对 G1 domain 的 initial runtime Target 与 run-003 live-acceptance Target 分别保留，补充
   lineage，不能用一个 ID 覆盖另一个。
6. 对 G2.3 的记录 revision `cf5efd85-ee39-4e29-a51c-d2cecd898839` 与当前 active revision
   `cf5efd85-ee39-42c4-8a4f-881630048727` 的差异追加 observation；不篡改历史 evidence。
7. 对 G2.4/G2.5 的本地 feature slice `accepted` 与 runtime Target `draft`、缺
   Review/Acceptance/EffectReceipt 的差异增加明确 status scope；不得把 slice acceptance
   冒充产品内 accepted Target。
8. 将 G2.6 缺失的 `reviews/independent-review.md` 明确记为 missing。Timeline 原事件保持
   append-only，不根据其摘要伪造 review 正文或 reviewer 决定。
9. 记录 G2.6 本地 5 条 AC 与当前 runtime revision 4 条 AC 的 drift；不直接改当前数据库。
10. 将根目录 `g25-evidence-tab.md` 绑定到 G2.5 记录；将 G2.4 timeline 提及但仓库不存在的
    `g24-evidence-tab-acceptance.png` 标记为 missing，不补造截图。
11. G1 brand/frontend/domain 和 G2.0/G2.1/G2.2 继续保持 `needs_review`，直到存在明确的
    Outcome Owner acceptance；merge commit 只能证明代码已合并，不能证明目标已验收。

## 明确排除的伪关闭证据

- G2.5 Fake GitHub Connector 证明接口和领域门禁，不证明真实 PR 或 EffectReceipt。
- G2.4/G2.5 手工 seed 证明 read model 能显示事实，不证明自动生产闭环。
- G2.6 outbox freeze/Worker restart 证明 dispatcher 恢复，不证明主动 Graph 编排或 Runner/Provider 联合恢复。
- 本地 `.verrail` target 的 `accepted` 证明 feature slice 得到记录中的 Outcome Owner 授权，
  不自动等价于产品数据库中的 Target `accepted`。
- PR MERGED 证明代码进入历史，不替代 Review、Acceptance、发布或 ship record。

## 结论

T001 已建立可复核基线：历史代码均已进入当前 HEAD，但交付记录存在 11 个明确的 T002
对账项；G2.7 的 11 条验收标准目前 9 条 partial、2 条 missing；22 条系统不变量中 10 条
implemented、9 条 partial、3 条 missing。当前证据不支持“领域模型已重构完成”或“G2 已完成”
的声明。
