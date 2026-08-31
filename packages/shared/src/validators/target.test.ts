import { describe, expect, it } from "vitest";
import {
  createTargetSchema,
  parseStoredTargetReadModelV1,
  registerTargetProjectionSchema,
  targetIdempotencyKeySchema,
  targetListQuerySchema,
  targetReadModelV1Schema,
} from "./target.js";

const compatibilityReadModel = {
  schemaVersion: 1,
  projectionPolicyVersion: "g1.v1",
  targetId: "6335ad12-b200-54a5-a618-2e01c6cfe8e7",
  activeTargetRevisionId: "7cf80b02-a939-58c9-98bc-f13f5d08525a",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  authority: { kind: "compatibility", writer: "typescript-compatibility" },
  project: { id: "00000000-0000-4000-8000-000000000003", name: "Control plane" },
  source: {
    type: "issue",
    id: "00000000-0000-4000-8000-000000000002",
    identifier: "VER-1",
    href: "/VER/issues/VER-1",
    updatedAt: "2026-08-27T00:00:00.000Z",
    revisionKey: "2026-08-27T00:00:00.000Z",
  },
  title: "Ship a governed Target",
  summary: null,
  status: "active",
  outcomeOwner: null,
  currentStage: { key: "execute", label: "Execute" },
  risk: { level: "unknown" },
  attentionSummary: { total: 0, highestSeverity: null },
  artifactSummary: { count: 0, latestRevisionId: null },
  evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" },
  runSummary: { active: 0, failed: 0, latestRunId: null, latestRunAt: null },
  definition: null,
  compatibility: { readOnly: true, completionUnverified: false, missingFields: [], warnings: [] },
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  projectedAt: "2026-08-27T00:00:01.000Z",
} as const;

describe("target projection validators", () => {
  it("accepts an explicit operator mapping", () => {
    expect(registerTargetProjectionSchema.parse({
      sourceType: "issue",
      sourceId: "1313d865-e274-4a4a-91a7-22c9e44a31a1",
      eligibilityReason: "operator_mapping",
    })).toEqual({
      sourceType: "issue",
      sourceId: "1313d865-e274-4a4a-91a7-22c9e44a31a1",
      eligibilityReason: "operator_mapping",
    });
  });

  it("bounds list pagination and rejects unsupported sorting", () => {
    expect(targetListQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    expect(targetListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(targetListQuerySchema.safeParse({ sort: "title" }).success).toBe(false);
  });

  it("accepts a strict native Target command and rejects empty acceptance", () => {
    const input = {
      projectId: "1313d865-e274-4a4a-91a7-22c9e44a31a1",
      title: "Ship governed creation",
      outcomeOwner: { principalType: "user", principalId: "user-1" },
      goal: "Create one durable Target fact.",
      constraints: ["Keep one writer."],
      acceptanceCriteria: [{ title: "Creation is idempotent" }],
      riskLevel: "high",
    };
    expect(createTargetSchema.parse(input)).toEqual(input);
    expect(createTargetSchema.safeParse({ ...input, acceptanceCriteria: [] }).success).toBe(false);
  });

  it("bounds Target command idempotency keys", () => {
    expect(targetIdempotencyKeySchema.parse("target:create:1234")).toBe("target:create:1234");
    expect(targetIdempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(targetIdempotencyKeySchema.safeParse("bad key with spaces").success).toBe(false);
  });

  it("accepts only authority-consistent canonical Target read models", () => {
    expect(targetReadModelV1Schema.parse(compatibilityReadModel)).toEqual(compatibilityReadModel);
    expect(targetReadModelV1Schema.safeParse({
      ...compatibilityReadModel,
      authority: { kind: "native", writer: "go-domain-api" },
    }).success).toBe(false);
  });

  it("upgrades only the bounded legacy compatibility snapshot shape", () => {
    const { authority: _authority, definition: _definition, ...legacy } = compatibilityReadModel;
    const parsed = parseStoredTargetReadModelV1(legacy);

    expect(parsed.upgradedFrom).toBe("legacy_compatibility_missing_authority_definition");
    expect(parsed.model).toMatchObject({
      authority: { kind: "compatibility", writer: "typescript-compatibility" },
      definition: null,
      compatibility: { warnings: ["projection_schema_upgraded"] },
    });
    expect(() => parseStoredTargetReadModelV1({
      ...legacy,
      source: { ...legacy.source, type: "native" },
    })).toThrow();
  });
});
