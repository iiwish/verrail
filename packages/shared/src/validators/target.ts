import { z } from "zod";
import {
  TARGET_READ_MODEL_SCHEMA_VERSION,
  TARGET_STATUSES,
  type TargetReadModelV1,
} from "../types/target.js";

export const targetSourceTypeSchema = z.enum(["case", "issue"]);

const targetStageKeySchema = z.enum(["define", "execute", "verify", "accept", "unknown"]);
const targetRiskLevelSchema = z.enum(["unknown", "low", "medium", "high", "critical"]);
const isoDateTimeSchema = z.iso.datetime({ offset: true });

const targetProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
}).strict();

const compatibilityTargetSourceSchema = z.object({
  type: targetSourceTypeSchema,
  id: z.string().uuid(),
  identifier: z.string().nullable(),
  href: z.string().min(1),
  updatedAt: isoDateTimeSchema,
  revisionKey: z.string().min(1),
}).strict();

const nativeTargetSourceSchema = z.object({
  type: z.literal("native"),
  id: z.string().uuid(),
  identifier: z.null(),
  href: z.string().min(1),
  updatedAt: isoDateTimeSchema,
  revisionKey: z.string().min(1),
}).strict();

const targetDefinitionSchema = z.object({
  goal: z.string(),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
  }).strict()),
  deadline: z.iso.date().nullable(),
  policySummary: z.string().nullable(),
}).strict();

const targetCompatibilitySchema = z.object({
  readOnly: z.literal(true),
  completionUnverified: z.boolean(),
  missingFields: z.array(z.string()),
  warnings: z.array(z.string()),
}).strict();

const targetReadModelBaseSchema = z.object({
  schemaVersion: z.literal(TARGET_READ_MODEL_SCHEMA_VERSION),
  projectionPolicyVersion: z.string().min(1),
  targetId: z.string().uuid(),
  activeTargetRevisionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  project: targetProjectSchema.nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  status: z.enum(TARGET_STATUSES),
  outcomeOwner: z.object({
    principalType: z.enum(["user", "agent"]),
    principalId: z.string().min(1),
    displayName: z.string().nullable(),
  }).strict().nullable(),
  currentStage: z.object({
    key: targetStageKeySchema,
    label: z.string(),
  }).strict().nullable(),
  risk: z.object({ level: targetRiskLevelSchema }).strict(),
  attentionSummary: z.object({
    total: z.number().int().nonnegative(),
    highestSeverity: z.string().nullable(),
  }).strict(),
  artifactSummary: z.object({
    count: z.number().int().nonnegative(),
    latestRevisionId: z.string().nullable(),
  }).strict(),
  evidenceSummary: z.object({
    count: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(),
    coverage: z.enum(["unknown", "partial", "complete"]),
  }).strict(),
  runSummary: z.object({
    active: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    latestRunId: z.string().nullable(),
    latestRunAt: isoDateTimeSchema.nullable(),
  }).strict(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  projectedAt: isoDateTimeSchema,
}).strict();

const compatibilityTargetReadModelV1Schema = targetReadModelBaseSchema.extend({
  authority: z.object({
    kind: z.literal("compatibility"),
    writer: z.literal("typescript-compatibility"),
  }).strict(),
  source: compatibilityTargetSourceSchema,
  definition: z.null(),
  compatibility: targetCompatibilitySchema,
}).strict();

const nativeTargetReadModelV1Schema = targetReadModelBaseSchema.extend({
  authority: z.object({
    kind: z.literal("native"),
    writer: z.literal("go-domain-api"),
  }).strict(),
  source: nativeTargetSourceSchema,
  definition: targetDefinitionSchema,
  compatibility: z.null(),
}).strict();

export const targetReadModelV1Schema: z.ZodType<TargetReadModelV1> = z.union([
  compatibilityTargetReadModelV1Schema,
  nativeTargetReadModelV1Schema,
]);

const legacyCompatibilityTargetReadModelV1Schema = targetReadModelBaseSchema.extend({
  source: compatibilityTargetSourceSchema,
  compatibility: targetCompatibilitySchema,
}).strict();

export type StoredTargetReadModelUpgrade = "legacy_compatibility_missing_authority_definition";

export interface ParsedStoredTargetReadModelV1 {
  model: TargetReadModelV1;
  upgradedFrom: StoredTargetReadModelUpgrade | null;
}

export function parseStoredTargetReadModelV1(value: unknown): ParsedStoredTargetReadModelV1 {
  const current = targetReadModelV1Schema.safeParse(value);
  if (current.success) return { model: current.data, upgradedFrom: null };

  const legacy = legacyCompatibilityTargetReadModelV1Schema.safeParse(value);
  if (!legacy.success) throw current.error;

  return {
    model: targetReadModelV1Schema.parse({
      ...legacy.data,
      authority: { kind: "compatibility", writer: "typescript-compatibility" },
      definition: null,
      compatibility: {
        ...legacy.data.compatibility,
        warnings: [
          ...new Set([
            ...legacy.data.compatibility.warnings,
            "projection_schema_upgraded",
          ]),
        ],
      },
    }),
    upgradedFrom: "legacy_compatibility_missing_authority_definition",
  };
}

export const registerTargetProjectionSchema = z.object({
  sourceType: targetSourceTypeSchema,
  sourceId: z.string().uuid(),
  eligibilityReason: z.enum(["explicit_marker", "approved_backfill", "operator_mapping"]),
}).strict();

export const targetListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  projectId: z.string().uuid().optional(),
  status: z.enum(TARGET_STATUSES).optional(),
  ownerId: z.string().trim().min(1).max(200).optional(),
  attention: z.enum(["true", "false"]).optional(),
  sort: z.enum(["updated_desc"]).optional().default("updated_desc"),
}).strict();

const nullableTrimmed = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const createTargetSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  summary: nullableTrimmed(2_000),
  outcomeOwner: z.discriminatedUnion("principalType", [
    z.object({
      principalType: z.literal("user"),
      principalId: z.string().trim().min(1).max(200),
    }).strict(),
    z.object({
      principalType: z.literal("agent"),
      principalId: z.string().uuid(),
    }).strict(),
  ]),
  goal: z.string().trim().min(1).max(4_000),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(20),
  acceptanceCriteria: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    description: nullableTrimmed(2_000),
  }).strict()).min(1).max(20),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  deadline: z.iso.date().nullable().optional(),
  policySummary: nullableTrimmed(4_000),
}).strict();

export const targetIdempotencyKeySchema = z.string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid idempotency key");

export type RegisterTargetProjectionInput = z.infer<typeof registerTargetProjectionSchema>;
export type TargetListQuery = z.infer<typeof targetListQuerySchema>;
export type CreateTargetInput = z.infer<typeof createTargetSchema>;
