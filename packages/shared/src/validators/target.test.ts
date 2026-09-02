import { describe, expect, it } from "vitest";
import {
  createGraphRevisionSchema,
  createTargetSchema,
  targetIdempotencyKeySchema,
  targetListQuerySchema,
  targetReadModelV1Schema,
} from "./target.js";

const nativeReadModel = {
  schemaVersion: 1,
  readModelPolicyVersion: "native.v1",
  targetId: "6335ad12-b200-44a5-a618-2e01c6cfe8e7",
  activeTargetRevisionId: "7cf80b02-a939-48c9-98bc-f13f5d08525a",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  collection: null,
  title: "Ship a governed Target",
  summary: null,
  status: "draft",
  outcomeOwner: { principalType: "user", principalId: "user-1", displayName: "Owner" },
  currentStage: { key: "define", label: "Define" },
  risk: { level: "high" },
  attentionSummary: { total: 1, highestSeverity: "info" },
  artifactSummary: { count: 0, latestRevisionId: null },
  evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" },
  runSummary: { active: 0, failed: 0, latestRunId: null, latestRunAt: null },
  definition: {
    goal: "Create one durable Target fact.",
    constraints: [],
    acceptanceCriteria: [{ id: "criterion-1", title: "It is durable", description: null }],
    deadline: null,
    policySummary: null,
    resourceRefs: [],
  },
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  projectedAt: "2026-08-27T00:00:01.000Z",
} as const;

describe("native Target validators", () => {
  it("bounds list pagination and rejects unsupported sorting", () => {
    expect(targetListQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    expect(targetListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(targetListQuerySchema.safeParse({ sort: "title" }).success).toBe(false);
  });

  it("accepts a strict native Target command and rejects empty acceptance", () => {
    const input = {
      collectionId: "1313d865-e274-4a4a-91a7-22c9e44a31a1",
      title: "Ship governed creation",
      outcomeOwner: { principalType: "user" as const, principalId: "user-1" },
      goal: "Create one durable Target fact.",
      constraints: ["Keep one writer."],
      acceptanceCriteria: [{ title: "Creation is idempotent" }],
      riskLevel: "high" as const,
    };
    expect(createTargetSchema.parse(input)).toEqual({ ...input, resourceRefs: [] });
    expect(createTargetSchema.safeParse({ ...input, acceptanceCriteria: [] }).success).toBe(false);
  });

  it("accepts a native graph revision and rejects duplicate-looking invalid node keys", () => {
    const result = createGraphRevisionSchema.parse({
      expectedTargetRevisionId: nativeReadModel.activeTargetRevisionId,
      nodes: [{ nodeKey: "implement", kind: "agent_task", stage: "execute", title: "Implement", completionDefinition: "Return a reviewable result." }],
    });
    expect(result.nodes[0]?.dependencyNodeKeys).toEqual([]);
    expect(createGraphRevisionSchema.safeParse({
      expectedTargetRevisionId: nativeReadModel.activeTargetRevisionId,
      nodes: [{ nodeKey: "bad key", kind: "agent_task", stage: "execute", title: "Implement", completionDefinition: "Return a reviewable result." }],
    }).success).toBe(false);
  });

  it("bounds Target command idempotency keys", () => {
    expect(targetIdempotencyKeySchema.parse("target:create:1234")).toBe("target:create:1234");
    expect(targetIdempotencyKeySchema.safeParse("short").success).toBe(false);
  });

  it("accepts only the native Target read model", () => {
    expect(targetReadModelV1Schema.parse(nativeReadModel)).toEqual(nativeReadModel);
    expect(targetReadModelV1Schema.safeParse({
      ...nativeReadModel,
      source: { type: "issue", id: "legacy" },
    }).success).toBe(false);
  });
});
