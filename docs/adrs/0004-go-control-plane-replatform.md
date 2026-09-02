# ADR-0004：以 Go 重构 Verrail 控制平面内核

状态：`Accepted`

日期：2026-08-26

## 上下文

Verrail 当前继承的 TypeScript 后端已经覆盖认证、Agent、Issue、Pipeline、Document、Secret、Storage、Plugin、Adapter、成本、通知、安装和运行恢复等广泛能力。当前仓库的后端相关规模包括：

| 范围 | 生产代码 | 测试代码 |
| --- | ---: | ---: |
| `server/src` | 约 274k 行 | 约 284k 行 |
| `packages/db` | 约 12k 行 | 约 5k 行 |
| `packages/shared` | 约 34k 行 | 约 8k 行 |
| `packages/adapters` | 约 36k 行 | 约 25k 行 |
| `packages/adapter-utils` | 约 29k 行 | 约 38k 行 |
| `cli` | 约 29k 行 | 约 14k 行 |

以上范围合计约 414k 行生产 TypeScript 和 374k 行测试。数据库当前包含 300 余个迁移文件；其中 `heartbeat.ts` 约 20k 行、`recovery/service.ts` 约 6k 行，Issue 路由与服务合计约 22k 行。调度、恢复、Issue 和兼容领域服务中存在大量隐含行为，完整重写的主要成本是合同发现、行为等价、数据迁移、安全审查和故障验证，而不是生成 Go 语法。

同时，Verrail 已确认采用 Temporal，并希望形成长期可维护的强类型控制平面、独立 Worker、Gateway 和 Runner。若 Go 是目标技术栈，新 Verrail 领域先在 TypeScript 实现再迁移会形成一次短命实现。

## 方案

### A. TypeScript 控制平面加 Temporal TypeScript SDK

交付最快，可以最大化复用现有服务，但不满足完整 Go 重构方向，并会把新领域继续绑定在现有大型服务边界上。

### B. 一次性全量 Go 重写

代码形态最统一，但在新旧系统同时变化时难以证明行为、数据和权限等价，切换窗口过长，不接受。

### C. Go Verrail Kernel 加 TypeScript Compatibility Service

Go 直接承载新的 Verrail 领域和 Temporal Workflow。现有 TypeScript 服务保留尚未迁移的 Paperclip 能力，通过版本化协议与 Go 内核协作。每个垂直切片完成后转移唯一写入权并删除对应兼容路径。

## 决策

采用方案 C，并遵守以下边界：

1. Go 是新 Verrail Domain API、Graph Engine、Temporal Worker、Execution Gateway、Runner 和核心后台 Worker 的目标语言；
2. React UI 保持 TypeScript，通过 OpenAPI 或 Protobuf 生成的客户端访问版本化 API；
3. 已成熟的 CLI Agent Adapter、Plugin SDK 和部分工具链初期保留 TypeScript，通过语言中立 Runner/Adapter 协议接入；
4. PostgreSQL Schema 是共享迁移边界，但同一聚合在任何阶段只有一个写入所有者；
5. 迁移不使用长期双写。读兼容通过 API、事件投影或只读视图完成；
6. Temporal 的新 `TargetWorkflow` 和 `RunWorkflow` 从第一版使用 Go SDK，不建设待迁移的 TypeScript Workflow；
7. 旧 `heartbeat`、`recovery`、Pipeline、Case 和 Issue 路径作为 Compatibility Service 运行，按垂直切片退役；
8. 数据迁移使用可重跑的 backfill、校验查询、抽样对账和显式 cutover checkpoint；
9. 每个切片必须包含 API 合同测试、状态迁移测试、故障注入、旧新行为对照、审计和回滚方案；
10. 不以总代码翻译率衡量进度，以完成闭环的 Target、可验证 Submission 和退役的旧写路径衡量进度。

## 目标服务边界

| 组件 | 目标职责 | 初始语言 |
| --- | --- | --- |
| Domain API | Workspace、Collection、Target、TargetRevision、Graph、Run、IntegrationRun、HumanWorkResult、Artifact、VerificationResult、Submission、Review、Acceptance | Go |
| Temporal Worker | Target/Agent Run Workflow、Integration 协调、人工等待、Timer、Signal、Activity 编排 | Go |
| Execution Gateway | Session、Lease、事件流、Artifact 上传、取消和 fencing | Go |
| Headless Runner | RuntimeProfile、进程生命周期、资源与隔离适配 | Go |
| Compatibility Service | 尚未迁移的 Paperclip API 和后台任务 | TypeScript |
| Adapter Host | CLI/API Agent Adapter 与 Plugin 兼容 | TypeScript，按价值选择性迁移 |
| Web UI | 操作台和生成 API Client | TypeScript/React |

组件边界是部署和所有权边界，不要求一开始拆成多个仓库或多个可独立部署的微服务。Go 内核优先保持模块化单体，避免在领域尚未稳定时引入分布式事务。

## 工作量评估

以下为基于当前代码规模和领域迁移范围的工程评估，不是按行数线性换算：

| 目标 | Codex + GPT-5.6-sol 辅助的单人日历时间 | 3 至 5 名强工程师 |
| --- | --- | --- |
| Temporal 技术基线与一条可运行垂直切片 | 10 至 14 周 | 6 至 10 周 |
| 可用于真实项目的 Verrail 核心闭环 | 4 至 7 个月 | 3 至 5 个月 |
| 大部分核心控制平面由 Go 承载 | 6 至 10 个月 | 4 至 7 个月 |
| 现有后端能力的高可信完整等价 | 9 至 15 个月 | 6 至 9 个月 |

关键阶段可以重叠，但验收门禁不能省略：

| 阶段 | 内容 | 参考工作量 |
| --- | --- | ---: |
| 0 | 合同盘点、Temporal Spike、Go 工程基线、性能与故障基线 | 3 至 5 周 |
| 1 | Workspace/Collection/Target/TargetRevision、Outbox、认证与 API 基线 | 5 至 8 周 |
| 2 | Graph Engine、TargetWorkflow、RunWorkflow、兼容桥 | 6 至 10 周 |
| 3 | Submission、Artifact、Evidence、Review、Acceptance 和一条 GitHub 闭环 | 8 至 12 周 |
| 4 | Execution Gateway、Runner、Lease/Fencing、Secret 与 Artifact 数据面 | 8 至 14 周 |
| 5 | 企业权限、策略、预算、审计、通知、安装和选择性兼容迁移 | 10 至 18 周 |
| 6 | 数据回填、行为对照、负载与故障测试、切换和旧路径退役 | 8 至 16 周 |

AI 可以显著加速工程骨架、机械迁移、测试生成、合同同步和静态检查。领域判定、权限与租户边界、迁移正确性、外部副作用、故障语义和生产切换仍需人工负责。计划不使用“AI 生成速度”等同于“可上线速度”的假设。

## 阶段门禁

每个迁移阶段只有同时满足以下条件才可转移写入权：

- 新旧 API 契约和关键状态机存在可执行对照；
- PostgreSQL 回填可以重复执行且结果可校验；
- Temporal Workflow 完成 replay、升级、超时、取消和故障恢复测试；
- 所有外部副作用有 idempotency key、receipt 和未知结果处理；
- Workspace 隔离、Agent 权限、Secret 和审计通过专项验证；
- 关键生产指标、告警、runbook 和回滚检查点就绪；
- 切换后不存在同一聚合的长期双写。

## 后果

- 新 Verrail 领域无需经历 TypeScript 到 Go 的二次迁移；
- 团队需要同时维护 Go Kernel 与 TypeScript Compatibility Service 一段明确的过渡期；
- 协议、Schema 所有权和生成客户端成为跨语言治理重点；
- 完整继承能力不会自动获得迁移优先级，低价值兼容功能可以留存、替换或退出；
- 发布节奏以可上线垂直切片为单位，避免长时间不可验证的重写分支。

## 与既有 ADR 的关系

本 ADR 取代 ADR-0001 和 ADR-0002 中与 Go 目标边界冲突的部分：

- 取代 ADR-0001 第 7 条关于 TypeScript 正式控制平面的长期结论；
- 取代 ADR-0002 第 1、7、8 条关于控制平面语言和 Go 提取范围的结论；
- 保留 ADR-0001 的硬分叉、许可证、可复用基座和渐进迁移决策；
- 保留 ADR-0002 的独立执行平面、Runner 出站连接、SandboxDriver、Lease 和 fencing 决策。

ADR-0005 明确 Target 直接属于 Workspace，Collection 只作为可选归类。本文中阶段与服务表的旧 Project 表达不构成 Target 层级。

## 否决方案

- 按目录或文件逐行翻译：复制历史结构，不形成 Verrail 领域边界；
- UI、Adapter 和 Plugin 同步全量迁移：扩大范围且产品收益有限；
- 新旧服务长期共享写入：故障语义和数据所有权不可审计；
- 先完成全部 Go 基础设施再交付产品切片：无法验证产品方向和迁移方法；
- 仅依赖生成测试证明等价：测试会复制原实现假设，不能替代合同和生产事实校验。
