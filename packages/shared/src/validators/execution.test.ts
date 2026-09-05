import { describe, expect, it } from "vitest";
import { reportRunEventSchema } from "./execution.js";

const hash = "a".repeat(64);
const artifact = { title: "Candidate", kind: "report", contentHash: hash, contentRef: `storage:86679997-3f3a-4477-a2fa-d4da812140ae/verrail/run-artifacts/sha256/${hash}` };
const event = { leaseId: "1e82be4a-a466-4c28-bee6-eb9609b68401", fencingToken: 1, cursor: 3, eventType: "succeeded", emittedAt: "2026-09-05T14:00:00.000Z", artifacts: [artifact] };
describe("Run event artifact contract", () => {
  it("accepts bounded typed outputs on success", () => {
    expect(reportRunEventSchema.parse(event).artifacts).toEqual([artifact]);
  });
  it.each(["started", "progress", "failed", "terminated"])("rejects outputs on %s", (eventType) => {
    expect(reportRunEventSchema.safeParse({ ...event, eventType }).success).toBe(false);
  });
  it("rejects forged source identities, external paths, and excess output counts", () => {
    for (const artifacts of [[{ ...artifact, sourceRunId: "forged" }], [{ ...artifact, contentRef: "file:/etc/passwd" }], Array.from({ length: 11 }, () => artifact)]) {
      expect(reportRunEventSchema.safeParse({ ...event, artifacts }).success).toBe(false);
    }
  });
  it("keeps events without artifacts compatible", () => {
    expect(reportRunEventSchema.parse({ ...event, artifacts: undefined, eventType: "heartbeat" }).artifacts).toBeUndefined();
  });
});
