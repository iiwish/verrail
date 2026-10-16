# G2.7 需求质量检查

Version: v1.0
Status: Completed
Source spec: `.verrail/targets/g2-7-production-closure/spec.md` (Confirmed)
Last updated: 2026-09-04

## 检查结果

- [x] Target 意图、范围、依赖和非目标均已明确。
- [x] 创建、执行、提交、评审、Action Approval、外部 Effect 和 Acceptance 均说明了 actor、触发条件和结果事实。
- [x] AC-01 至 AC-11 均可由文件、数据库事实、命令回执、测试、浏览器操作或真实 Provider 结果验证。
- [x] 普通会话消息与显式 Target 创建意图区分清楚，最终确认仍由已授权真人完成。
- [x] Workspace、TargetRevision、GraphRevision、AgentVersion、DeploymentRevision、RunAttempt、Commit 和 Criterion 的边界已纳入验收。
- [x] Submission、Review、ActionRequest、ActionApproval、EffectReceipt 和 Acceptance 的身份及版本失效规则已明确。
- [x] 单真人模型已明确：Agent/Service 提交候选，真人分别执行 Review、Action Approval 和 Acceptance；不使用虚假真人账号。
- [x] Secret 边界已明确：GitHub 短期凭证只经 TypeScript facade 临时传给 Go，不持久化、不记录日志、不进入 Temporal History。
- [x] Provider 超时和结果不确定性由 UnknownEffect、稳定 marker 和 lookup-before-retry 覆盖。
- [x] API、Worker、Runner 和 Provider 故障、重试、取消、租约过期、旧 attempt 覆盖和恢复路径均在验收范围内。
- [x] Web Chat、飞书和 Target Workbench 的空态、错误态、权限拒绝、失效和恢复操作均进入工作图。
- [x] 数据迁移采用 expand/contract，禁止通过破坏性 down migration 清理生产事实。
- [x] UI 必须遵守 `DESIGN.md`、token gate、响应式和无障碍约束。
- [x] G3 重构、多企业通道、其他 SCM、生产发布和未经授权的 ship record 已明确排除。
- [x] 每条验收标准都映射到至少一个任务，每个任务都有依赖、允许范围、验证和证据合同。

## 风险分级

- Critical: 0
- High: 0
- Medium: 1
- Low: 1

### Medium

真实闭环验收依赖外部 Feishu 应用/会话和 GitHub 测试仓库/短期凭证。这不是需求歧义，
但如果 T010 前仍未具备，真实 Provider 证据将无法完成。T010 已把这些列为显式外部前置条件，
此前任务可以在 fake provider、契约测试和本地故障注入下推进。

### Low

G2.7 没有新增数值型性能 SLO。当前关闭标准以正确性、幂等、恢复、可操作性和已有产品目标为准；
如实现引入明显性能回归，必须在任务评审中阻塞，不能以“规格未给阈值”为由接受。

## 已关闭的需求疑问

1. 企业通道：Outcome Owner 已于 2026-09-04 正式选择飞书。
2. GitHub 凭证：Outcome Owner 已批准由 TypeScript facade 临时传给 Go，并禁止持久化和日志记录。
3. 真人身份：一个真人足够；Submission 和 ActionRequest 必须由授权 Agent 或 Service 发起，
   Review、Action Approval 和 Acceptance 仍是三个独立命令与审计事实。

## 审核结论

需求检查完成，无 Critical 或 High 问题。产品规格、技术计划和工作图已经 Outcome Owner
确认；T001 已进入 Ready。后续技术计划闸门由 Codex 按依赖和证据连续推进，最终真人治理决定
及目标验收仍由 Outcome Owner 完成。
