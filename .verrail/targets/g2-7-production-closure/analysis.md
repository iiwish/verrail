# G2.7 Post-Spec Analysis

Version: v1.0
Status: Completed
Source spec: `.verrail/targets/g2-7-production-closure/spec.md` (Confirmed)
Source plan: `.verrail/targets/g2-7-production-closure/plan.md` (Confirmed)
Source work graph: `.verrail/targets/g2-7-production-closure/tasks.md` (Confirmed)
Last updated: 2026-09-04

## 分析范围

本分析检查需求覆盖、任务依赖、宪法和领域不变量一致性、非功能要求、文件所有权、
验证闭环和首个 execution packet。它不批准计划，也不启动实现。

## 需求覆盖

| Acceptance criterion | Tasks | Coverage |
| --- | --- | --- |
| AC-01 交付事实对账 | T001, T002, T010 | 完整 |
| AC-02 Web Chat 与企业通道创建入口 | T009, T008, T010 | 完整 |
| AC-03 固定版本的真实 Agent 执行 | T003, T004, T005, T010 | 完整 |
| AC-04 持久 Graph/Temporal 编排 | T005, T010 | 完整 |
| AC-05 完整工作结果合同 | T004, T010 | 完整 |
| AC-06 独立 assurance、review、acceptance | T003, T004, T007, T008, T010 | 完整 |
| AC-07 安全且恰好一次的 GitHub Effect | T006, T007, T008, T010 | 完整 |
| AC-08 版本和参数失效 | T003, T006, T007, T008, T010 | 完整 |
| AC-09 产品 UI 闭环 | T007, T009, T008, T010 | 完整 |
| AC-10 故障恢复 | T005, T006, T007, T010 | 完整 |
| AC-11 发布门禁和可检查证据 | T001 至 T010 | 完整 |

未映射验收标准：0。

## 工作图检查

- 依赖图无环，唯一初始入口为 T001。
- T001 至 T010 均有单一任务目标、允许修改范围、验证命令、证据合同和 packet 路径。
- T009 排在 T008 前是有意的：Workbench 的企业通道绑定与状态展示依赖先稳定 Channel Connector 合同。
- T002、T003、T004、T005、T006 和 T007 修改共享领域边界，已通过顺序依赖避免同时写冲突。
- T009 可在 T002 后准备，但本工作图仍要求一次只执行一个 governed task，避免外部通道合同与核心领域漂移。
- T010 只在所有前置任务 Accepted、外部账号就绪且全量验证可重复后进入 Ready。

## 不变量检查

- Workspace 边界：每个新事实和命令都要求 Workspace-scoped 身份与复合约束。
- 写入 Owner：Graph Engine 裁决节点和 Target 状态；Temporal 只协调命令。
- 授权分离：Invocation、Execution、Decision、Action Approval、Acceptance 保持不同命令和审计事实。
- 身份真实性：principal 从认证边界注入，请求体不能自报 agent/service；不使用虚假真人账号。
- 版本绑定：Artifact、Evidence、Review、Acceptance、Action Approval 和 Effect 都绑定不可变输入。
- 恢复安全：租约、fencing、幂等、Continue-As-New、UnknownEffect 和 lookup-before-retry 均有任务覆盖。
- Secret 安全：credential 不进入领域事实、日志、回执或 workflow payload。
- 外部 Effect：先审批、执行时再校验、结果不明先查询、禁止盲目重放。

Constitution violations: 0。

## 非功能与迁移覆盖

- Security：T003、T006、T009 覆盖 principal、Secret、webhook 验签、重放和 Workspace 串线。
- Reliability：T005、T006、T007、T010 覆盖重启、超时、重试、取消、失效和 Provider 不确定结果。
- Observability：使用受控审计、command receipt、workflow history 和本地 run evidence；本目标不扩展默认外发 Telemetry。
- UI quality：T008、T009 要求错误可见、权限清楚、键盘/响应式可用并通过 token gate。
- Migration：T004、T006 采用前向 expand migration、兼容读取和无破坏回滚。
- Performance：没有新数值 SLO；任务评审仍需阻塞明显的查询、workflow history 或 UI 回归。

## 计划可执行性校验

- 根脚本确认存在：`test:domain-api`、`db:generate`、`typecheck`、`check:token-gates`、
  `test:run`、`build` 和 `test:e2e:verrail-acceptance`；DB package 确认存在 `check:migrations`。
- T003 至 T010 所引用的现有 Go、TypeScript、React、插件 SDK、验收测试和设计规范路径均存在。
- 明确标为新建的路径只有工作结果 schema、Channel Connector shared contract、Feishu plugin 和
  Channel Connector host；它们均有现有 package/host 边界可承载，不要求另建平行架构。
- `adjudication_store.go:78` 仍把 Submission 发起类型写死为 `user`；
  `connector_store.go:165` 仍把 ActionRequest 发起类型写死为 `user`，验证了 T003 的必要性。
- `orchestration/workflow.go` 当前只有 Signal、Query、去重和 Continue-As-New，没有
  Activity、Child Workflow 或 Timer，验证了 T005 的边界。
- `connector_store.go:313-346` 当前在数据库事务内调用 GitHub，并在调用成功后才写
  EffectReceipt；Provider 成功、事务失败时缺少对账状态，验证了 T006 的 UnknownEffect 设计。
- 当前插件树中没有 Feishu/Lark 或通用 Channel Connector 实现，验证了 T009 是新增纵向切片，
  而不是重复已有通道。

结论：计划中的命令和所有既有路径可执行；未发现需要改写工作图的路径错误或脚本缺口。

## 发现

### Medium

T010 需要用户控制的 Feishu 应用/会话和 GitHub 测试仓库/短期凭证。缺少它们不会阻塞
T001 至 T009，但会阻塞真实生产闭环验收。不得用 mock 或测试 fixture 替代 T010 的 Provider 证据。

### Low

规格没有新增数值型性能门槛。执行阶段应保存关键查询、workflow history 和浏览器交互的基线，
出现明显回归时由任务 review 阻塞。

Critical: 0。High: 0。

## Packet 检查

- 首个 packet：`.verrail/targets/g2-7-production-closure/execution-packet.json`
- Packet task：T001
- Packet 状态：`completed`
- 允许范围只包含 gap matrix、T001 run evidence 和当前 timeline。
- 其他任务仍为 Draft；依赖未满足前不生成可执行 packet。

## 执行闸门

Result: T001 passed; T002 ready

Outcome Owner 已批准技术计划和工作图，并委托 Codex 自行处理后续技术计划闸门。T001 已完成
证据、范围和技术 review，获准用于依赖推进；T002 已进入 Ready。T003 至 T010 继续保持 Draft，
按依赖、packet、证据和技术评审逐个解锁。最终真人治理决定和目标验收仍不得由 Codex 代替。
