# TargetReadModel 数据与 API 实施合同

版本：0.1

状态：`Confirmed`

最后更新：2026-08-26

变更要求：来源资格、标识算法、投影字段、权限、API、状态映射或兼容删除条件发生变化时重新评审本合同

## 1. 目的

`TargetReadModel` 为首个 Verrail Target Workbench 提供稳定、版本化、可授权和可重建的只读投影。它允许 TypeScript 兼容控制平面从已明确映射的 Case、Issue 和关联事实读取 Target 语义，同时不创建新的权威 Target 写模型，也不改变现有对象的写入所有权。

投影回答“用户当前可以看到哪个交付目标、它来自哪里、处于什么阶段、有哪些风险和证明”。它不能裁决完成、验收、授权或 Graph 状态。

## 2. 权威边界

1. Case、Issue、Project、Run、Artifact、Evidence、Approval 等原表继续拥有 G1 的写入事实；
2. `TargetReadModel`、投影来源映射和投影快照均可重建，不成为领域写入入口；
3. UI 只消费服务端返回的 `targetId` 和 `targetRevisionId`，不得拼接、哈希或猜测标识；
4. 兼容来源的 `done`、`approved` 或 Review 状态不能产生 `accepted` Target；只有绑定版本的有效 Acceptance 可以产生 `accepted`；
5. 来源缺失、映射不可靠或权限无法证明时返回兼容链接或 Not Found，不生成空壳 Target；
6. PostgreSQL 中的投影记录用于稳定查询、对账和缓存，不改变 PostgreSQL 业务事实源与 Temporal 编排边界。

## 3. 来源资格与映射

### 3.1 显式来源登记

每个投影必须有一条 `target_projection_sources` 记录：

| 字段 | 约束 |
| --- | --- |
| `workspace_id` | 使用 G1 的 `companies.id` 兼容身份；必须与来源对象一致 |
| `target_id` | 服务端按第 4 节生成的稳定 UUID |
| `source_type` | G1 只允许 `case` 或 `issue` |
| `source_id` | 来源对象 UUID |
| `projection_policy_version` | 生成字段和状态映射的规则版本 |
| `eligibility_reason` | `explicit_marker`、`approved_backfill` 或 `operator_mapping` |
| `active_target_revision_id` | 当前不可变投影快照标识 |
| `source_revision_key` | 来源版本号、事件游标或稳定更新时间组合 |
| `source_snapshot_hash` | Canonical JSON 的 SHA-256 |
| `last_projected_at` | 最近成功投影时间 |
| `disabled_at` / `error_code` | 失效、歧义或对账失败状态 |

`(workspace_id, source_type, source_id)` 与 `(workspace_id, target_id)` 必须唯一。映射记录只能由版本化 Reconciler、批准的迁移或具备 Workspace 管理权限的运维命令创建；G1 不提供普通产品 UI 写入接口。

### 3.2 Case 规则

Case 只有在存在显式来源记录时成为 Target。Case 的子 Issue 通过 `case_issue_links` 提供 Work、Run 和 Attention 摘要，不各自生成 Target。Case 与 Project、Owner、Document 或 Issue 的 Workspace 不一致时，投影进入错误状态并从列表移除。

### 3.3 Issue 规则

Issue 默认是 Work，不是 Target。只有无 Case Target 归属、具备明确 Outcome/Owner/Project 语义并经过 `operator_mapping` 或 `approved_backfill` 的根 Issue 才可独立成为 Target。子 Issue、恢复 Issue、Routine Execution、Watchdog、Review、Onboarding 或其他系统派生 Issue 不得自动升级为 Target。

### 3.4 歧义处理

同一来源只能映射一个 Target；一个 Issue 同时被多个 Case 以 `origin` 或 `work` 角色声明时不进入聚合，记录 `ambiguous_case_membership`。来源删除后保留映射和不可变 Revision 快照，活动列表隐藏该 Target，固定 Revision 深链按权限返回历史快照和 `source_missing` 警告。

## 4. 稳定标识与版本

兼容标识使用 RFC 4122 UUIDv5，确保 TypeScript 与 Go 实现可独立重建相同结果：

- Target namespace：`91552506-d624-4f00-97cc-e5b6f4dff680`
- Target name：`workspaceId + "\n" + sourceType + "\n" + sourceId`
- TargetRevision namespace：`ae165b56-f7dd-4ce7-af56-8c5896162dd3`
- TargetRevision name：`targetId + "\n" + projectionPolicyVersion + "\n" + sourceRevisionKey + "\n" + sourceSnapshotHash`

输入使用小写 canonical UUID、UTF-8 和字面量 LF。标识算法和 namespace 是跨语言兼容协议；变更必须发布新算法版本并保留旧标识解析。前端把两个 UUID 都视为不透明标识。

`target_projection_revisions` 保存 `target_revision_id`、`target_id`、来源键、快照 Hash、Schema Version、投影 JSON 和创建时间。相同输入幂等产生同一 Revision；内容或规则变化产生新 Revision，历史 Revision 不覆盖。

## 5. 投影结构

`TargetReadModelV1` 最小结构为：

```ts
interface TargetReadModelV1 {
  schemaVersion: 1;
  projectionPolicyVersion: string;
  targetId: string;
  activeTargetRevisionId: string;
  workspaceId: string;
  project: { id: string; name: string } | null;
  source: {
    type: "case" | "issue";
    id: string;
    identifier: string | null;
    href: string;
    updatedAt: string;
    revisionKey: string;
  };
  title: string;
  summary: string | null;
  status:
    | "draft"
    | "ready"
    | "active"
    | "verifying"
    | "awaiting_acceptance"
    | "blocked"
    | "canceled"
    | "accepted";
  outcomeOwner: {
    principalType: "user" | "agent";
    principalId: string;
    displayName: string | null;
  } | null;
  currentStage: {
    key: "define" | "execute" | "verify" | "accept" | "unknown";
    label: string;
  } | null;
  risk: { level: "unknown" | "low" | "medium" | "high" | "critical" };
  attentionSummary: { total: number; highestSeverity: string | null };
  artifactSummary: { count: number; latestRevisionId: string | null };
  evidenceSummary: {
    count: number;
    passed: number;
    failed: number;
    inconclusive: number;
    coverage: "unknown" | "partial" | "complete";
  };
  runSummary: {
    active: number;
    failed: number;
    latestRunId: string | null;
    latestRunAt: string | null;
  };
  compatibility: {
    readOnly: true;
    completionUnverified: boolean;
    missingFields: string[];
    warnings: string[];
  };
  createdAt: string;
  updatedAt: string;
  projectedAt: string;
}
```

聚合摘要只计算 Principal 有权读取的对象。缺失数据使用 `null`、零值和 `missingFields` 表达，不使用虚构 Owner、Stage、Risk、Artifact 或 Evidence。

## 6. 状态与阶段映射

| 来源 | 来源状态 | Target 状态 | Stage | 附加规则 |
| --- | --- | --- | --- | --- |
| Case | `draft` | `draft` | Define | 无 |
| Case | `in_progress` | `active` | Execute | 无 |
| Case | `in_review` | `verifying` | Verify | 无 |
| Case | `approved` | `awaiting_acceptance` | Accept | Approval 不等于 Acceptance |
| Case | `done` | `awaiting_acceptance` | Accept | `completionUnverified=true` |
| Case | `cancelled` | `canceled` | 当前或 Unknown | 无 |
| Issue | `backlog` | `draft` | Define | 仅显式独立映射 |
| Issue | `todo` | `ready` | Define | 仅显式独立映射 |
| Issue | `in_progress` | `active` | Execute | 仅显式独立映射 |
| Issue | `in_review` | `verifying` | Verify | 仅显式独立映射 |
| Issue | `blocked` | `blocked` | 当前或 Unknown | 生成 Attention 摘要 |
| Issue | `done` | `awaiting_acceptance` | Accept | `completionUnverified=true` |
| Issue | `cancelled` | `canceled` | 当前或 Unknown | 无 |

兼容投影不会产生 `accepted`。该值只为后续权威 Target/Acceptance 读取保持 Schema 兼容。

## 7. API 合同

G1 注册以下 Canonical Read API；`workspaceId` 使用当前 Workspace 的 `companies.id`：

```text
GET /api/workspaces/:workspaceId/targets
GET /api/workspaces/:workspaceId/projects/:projectId/targets
GET /api/workspaces/:workspaceId/targets/:targetId
GET /api/workspaces/:workspaceId/targets/:targetId/revisions/:targetRevisionId
```

列表参数为 `limit`、`cursor`、`projectId`、`status`、`ownerId`、`attention` 和 `sort`。`limit` 默认 50、最大 100；默认排序为 `updatedAt desc, targetId asc`。Cursor 绑定 Workspace、Principal、过滤器、排序和投影版本，不能跨条件复用。

列表响应包含 `schemaVersion`、`projectionPolicyVersion`、`asOf`、`items` 和 `nextCursor`。详情响应包含单个模型。服务端支持 `ETag` / `If-None-Match`；ETag 覆盖 Principal、TargetRevision、可见聚合摘要和 Projection Version，不能跨 Principal 共用。

UI Canonical Route 使用 `/:workspacePrefix/targets/:targetId`，API 只接受不可变 Workspace UUID，不接受可变 Prefix。`source.href` 由统一 Route Resolver 生成并只指向有权访问的兼容页。

## 8. 权限与错误语义

1. 所有查询先校验 Workspace 访问，再按来源对象、Project 和聚合子对象权限求交集；
2. G1 不新增隐式 `targets:read` 扩权。Board 访问沿用当前 Workspace 成员/实例管理员边界；Agent 访问沿用来源 Issue、Case、Project 和运行可见性规则；
3. 列表静默排除不可见 Target，计数和 Cursor 只基于过滤后的集合；
4. Target 存在但调用者无 Workspace 或对象权限时统一返回 `404`，避免跨 Workspace 枚举；已进入有权 Workspace 后的产品 UI 可以用本地授权结果展示 Permission Denied，但服务端不泄露对象存在性；
5. `targetId` 与 Workspace 不匹配、Revision 不属于 Target、来源映射失效或已禁用时返回 `404`；
6. 投影暂时落后但有完整快照时返回 `200` 和 `warnings=["projection_stale"]`；没有可用快照时返回 `503`、稳定错误码 `TARGET_PROJECTION_UNAVAILABLE` 和可重试提示；
7. 任何读取不得在请求路径中隐式创建映射、修改来源或触发外部 Effect。

## 9. 新鲜度、重建与对账

- 来源事务提交后写入本地 outbox；Projector 消费 outbox 并幂等更新映射与 Revision；
- G1 新鲜度目标为 P95 5 秒内，详情允许在读取时比较 `source.updatedAt` 并标记 stale，不在请求内重建整批投影；
- 每小时 Reconciler 比较来源键、快照 Hash 和 Workspace 归属，修复漏事件并记录审计摘要；
- 全量重建使用影子表、数量/Hash/权限样本对账和原子切换，不原地清空正在服务的投影；
- Projection Version 回滚只切换读取版本，不回写 Case、Issue 或领域事实；
- 投影错误、延迟和对账差异保存在本实例数据库和运维日志中，不新增默认出站 Telemetry。

## 10. 兼容路由与降级

Target 深链只有在映射、快照和权限均有效时发布。映射不存在时，Project、Case 和 Issue 保持原链接；不存在从 `/cases/:id` 或 `/issues/:id` 到空 Target 的猜测性重定向。

Feature Flag 关闭时继续使用兼容 Shell 和来源页面。Flag 打开但单个 Target 不可投影时，列表显示可操作的兼容来源链接和明确错误，不用伪数据填充 Workbench。关闭 Flag 不删除映射、Revision 或历史深链。

## 11. 验收测试矩阵

1. 同一来源在 TypeScript 与 Go 生成相同 Target/Revision UUID；
2. 重放、重复事件、进程重启和全量重建保持标识与内容 Hash 幂等；
3. Case、Issue 状态映射覆盖所有合法状态，`done` 和 `approved` 永不产生 `accepted`；
4. 无映射、歧义、跨 Workspace、Project 不一致、来源删除和投影 stale 均产生合同规定的结果；
5. Board、Agent、跨 Workspace、受限 Project 和父子对象权限测试证明列表、详情、计数与 Cursor 不泄露对象；
6. Revision 深链在活动 Revision 变化后仍返回原不可变快照；
7. Cursor、过滤、排序、ETag、304、最大 Limit 和错误码有 API 合同测试；
8. Flag 开关、兼容回退、刷新、收藏和来源跳转有浏览器测试；
9. Projector 重放、Reconciler 修复、影子表切换和 Projection Version 回滚有集成测试；
10. 不产生新的默认出站 Telemetry 事件。

## 12. 非目标

- 不提供 Target、TargetRevision、AcceptanceCriterion、Submission 或 Acceptance 写 API；
- 不把 Case、Issue、Goal、Pipeline、Approval 或 Run 自动视为 Target；
- 不用投影状态驱动 Graph、Temporal、执行租约或外部 Action；
- 不删除或重命名现有 Case/Issue API、表、路由和技术标识；
- 不把 Projection JSON 作为后续权威 Go 领域表的迁移来源。
