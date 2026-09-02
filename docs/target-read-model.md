# Target Read Model Contract

## 1. 目的

TargetReadModel 是 Target 列表、Collection 筛选和 Target Workbench 共用的版本化读取合同。它只从 Verrail 原生 Target 事实重建，不从 Project、Case、Issue、聊天文本或运行日志推导 Target。

规范层级固定为：

```text
Workspace -> Target -> Work Graph -> Run / Artifact / Evidence / Acceptance
                     \
                      -> optional Collection association
```

Collection 只提供可选归类。Target 的身份、责任、版本、执行、证明和验收都不依赖 Collection。

## 2. 权威来源

原生 Target 读取至少使用以下事实：

- `verrail_targets`
- `verrail_target_revisions`
- `verrail_collections`
- Work Graph、Run、ArtifactRevision、Evidence、Submission、Review 和 Acceptance 的版本绑定事实

`TargetReadModel` 是可重建投影，不是写入所有者。创建或修改 Target 必须通过领域命令；客户端不得提交投影字段、伪造聚合摘要或从其他对象合成 Target ID。

Project、Case 和 Issue 不属于该合同，也不是 Target 的父级、来源或兼容归类。

## 3. 核心字段

```ts
interface TargetReadModelV1 {
  schemaVersion: 1;
  readModelPolicyVersion: "native.v1";
  targetId: string;
  activeTargetRevisionId: string;
  workspaceId: string;
  collection: { id: string; name: string } | null;
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
  definition: {
    goal: string;
    constraints: string[];
    acceptanceCriteria: Array<{
      id: string;
      title: string;
      description: string | null;
    }>;
    deadline: string | null;
    policySummary: string | null;
  };
  createdAt: string;
  updatedAt: string;
  projectedAt: string;
}
```

缺失的聚合事实使用 `null`、零值或 `unknown` 表达，不使用虚构 Owner、Stage、Risk、Artifact、Evidence 或 Run。

## 4. Collection 语义

- `collection` 可以为空；无 Collection 的 Target 仍是完整的一等对象。
- 创建 Target 时可以提交 `collectionId`，服务端必须校验 Collection 属于当前 Workspace 且未归档。
- Collection 名称只用于展示，不进入 TargetRevision 内容 Hash。
- 修改或归档 Collection 不得改变 TargetRevision、Work Graph、权限、策略、Evidence 或 Acceptance。
- Collection 计数和健康摘要必须在服务端授权过滤后计算。

## 5. API

```text
GET  /api/workspaces/:workspaceId/targets
GET  /api/workspaces/:workspaceId/collections/:collectionId/targets
GET  /api/workspaces/:workspaceId/targets/:targetId
GET  /api/workspaces/:workspaceId/targets/:targetId/revisions/:targetRevisionId
GET  /api/workspaces/:workspaceId/targets/:targetId/workspace
POST /api/workspaces/:workspaceId/targets
POST /api/workspaces/:workspaceId/targets/:targetId/conversation
POST /api/workspaces/:workspaceId/targets/:targetId/graph-revisions
POST /api/workspaces/:workspaceId/targets/:targetId/graph-revisions/:graphRevisionId/activate
POST /api/workspaces/:workspaceId/targets/:targetId/graph-revisions/:graphRevisionId/nodes/:workNodeId/runs
```

列表参数为 `limit`、`cursor`、`collectionId`、`status`、`ownerId`、`attention` 和 `sort`。默认排序为 `updatedAt desc, targetId asc`。Cursor 绑定 Workspace、Principal、过滤器、排序和投影版本，不能跨条件复用。

列表响应在授权过滤之后、分页之前计算 `summary.total`、`summary.open`、`summary.attention` 和 `summary.byCollection`。未归类 Target 计入总数，但不伪造 Collection ID。

## 6. 创建合同

创建 Target 只接受具备 Workspace 写权限的人类 Principal。请求必须包含目标标题、结果描述、Outcome Owner、约束、至少一条 Acceptance Criterion 和风险等级；截止时间、策略摘要和 `collectionId` 可选。

TypeScript 边缘先校验 Workspace 与 Collection 归属，再以内部凭据和 Principal Context 调用 Go Domain API。Go 服务再次校验成员、角色、ResourceScope、Outcome Owner 和 Collection 归属，并在一个事务中写入 Target、TargetRevision、幂等回执、审计事件和 Outbox 事实。

创建 Target 的同一事务还创建一个空的 WorkGraph 和首个草稿 GraphRevision。后续 GraphRevision 命令固定活动 TargetRevision，校验节点键、依赖引用和无环性；激活命令原子替换活动 GraphRevision，并通过 outbox 通知稳定 TargetWorkflow。Run 命令只接受活动 GraphRevision 中依赖已满足且状态为 `ready` 的 AgentTask 或 IntegrationTask，不为 HumanTask 或 GateNode 伪造 Run。

## 7. 权限与错误

1. 所有读取先校验 Workspace，再按 Target 和子对象权限求交集。
2. 列表静默排除不可见 Target；计数和 Cursor 只基于授权后的集合。
3. Target 不存在、跨 Workspace 或无权读取统一返回 `404`。
4. Collection 不存在、已归档或跨 Workspace 时，创建返回 `404`。
5. 无创建权限返回 `403 TARGET_CREATE_FORBIDDEN`。
6. Outcome Owner 无效返回 `422 TARGET_OWNER_INVALID`。
7. Go Domain API 不可用返回可重试的 `503 TARGET_DOMAIN_API_UNAVAILABLE`。

## 8. Workbench

`GET /targets/:targetId/workspace` 返回固定 TargetRevision 上下文中的 Stage、Work、Submission、Artifact、Evidence、Run 和 Timeline。空数组表示当前没有对应事实，界面不得填充演示数据。

Target Workbench 可以创建绑定当前 Target 和活动 TargetRevision 的持久 Conversation。Target 具有关联 Collection 时，服务端可以附加 Collection ContextBinding；客户端不能提交或覆盖这些绑定。创建 Conversation 不修改 Target 或任何交付事实。

## 9. 不变量

- Target 必须直接属于一个 Workspace。
- Target 可以不属于任何 Collection。
- Project、Case、Issue 和 ConversationMessage 不得自动转换或投影为 Target。
- TargetRevision、GraphRevision、ArtifactRevision、Evidence、Submission、Review 和 Acceptance 保持版本绑定。
- Target 或 Collection 的读取不得触发外部 Effect。
- Timeline 和聚合摘要必须能够从 PostgreSQL 事实重建。
