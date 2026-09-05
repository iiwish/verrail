import { z } from "zod";

export const runtimeProfileV1Schema = z.enum(["host_trusted"]);
export const runEventTypeV1Schema = z.enum([
  "claimed",
  "heartbeat",
  "started",
  "progress",
  "succeeded",
  "failed",
  "cancel_acknowledged",
  "terminated",
]);

export const createRunAttemptSchema = z.object({
  runtimeProfile: runtimeProfileV1Schema,
  executor: z.object({
    principalType: z.literal("service"),
    principalId: z.string().trim().min(1).max(200),
  }).strict(),
  leaseDurationSeconds: z.number().int().min(15).max(3_600).default(120),
  graceDurationSeconds: z.number().int().min(0).max(600).default(30),
}).strict();

export const reportRunEventSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventType: runEventTypeV1Schema,
  emittedAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(["code_change", "document", "report"]),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    contentRef: z.string().regex(/^storage:[a-f0-9-]{36}\/verrail\/run-artifacts\/sha256\/[a-f0-9]{64}$/),
  }).strict()).max(10).optional(),
  extendLeaseSeconds: z.number().int().min(15).max(3_600).optional(),
}).strict().refine((input) => !input.artifacts?.length || input.eventType === "succeeded", {
  message: "Artifacts require a succeeded event", path: ["artifacts"],
});

export const requestRunCancellationSchema = z.object({}).strict();

export const retryRunOutboxSchema = z.object({
  eventId: z.string().uuid(),
  expectedAttemptCount: z.number().int().positive().max(2_147_483_647),
}).strict();

export type CreateRunAttemptInput = z.infer<typeof createRunAttemptSchema>;
export type ReportRunEventInput = z.infer<typeof reportRunEventSchema>;
