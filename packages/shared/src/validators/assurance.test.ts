import { describe, expect, it } from "vitest";
import {
  addArtifactRevisionSchema,
  assuranceIdempotencyKeySchema,
  createArtifactSchema,
  createClaimSchema,
  recordEvidenceSchema,
  recordVerificationResultSchema,
} from "./assurance.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const hash = "a".repeat(64);

describe("assurance validators", () => {
  it("reuses the target idempotency key rules", () => {
    expect(assuranceIdempotencyKeySchema.parse("assurance:create:1234")).toBe("assurance:create:1234");
    expect(assuranceIdempotencyKeySchema.safeParse("short").success).toBe(false);
  });

  it("validates artifact creation", () => {
    expect(createArtifactSchema.parse({ targetId: uuid, kind: "code_change", title: "Landing page" })).toMatchObject({
      targetId: uuid,
      kind: "code_change",
      title: "Landing page",
    });
    expect(() => createArtifactSchema.parse({ targetId: uuid, kind: "binary", title: "x" })).toThrow();
    expect(() => createArtifactSchema.parse({ targetId: "not-a-uuid", kind: "report", title: "x" })).toThrow();
    expect(() => createArtifactSchema.parse({ targetId: uuid, kind: "report", title: "" })).toThrow();
    expect(() => createArtifactSchema.parse({ targetId: uuid, kind: "report", title: "x", extra: 1 })).toThrow();
  });

  it("requires a lowercase 64-hex content hash for revisions", () => {
    const base = { artifactId: uuid, contentRef: "git:abc123" };
    expect(addArtifactRevisionSchema.parse({ ...base, contentHash: hash })).toMatchObject({ contentHash: hash });
    expect(() => addArtifactRevisionSchema.parse({ ...base, contentHash: hash.toUpperCase() })).toThrow();
    expect(() => addArtifactRevisionSchema.parse({ ...base, contentHash: "a".repeat(63) })).toThrow();
    expect(() => addArtifactRevisionSchema.parse({ ...base, contentHash: hash, contentRef: "" })).toThrow();
  });

  it("bounds claim criterion keys and titles", () => {
    const base = { targetId: uuid, targetRevisionId: uuid };
    expect(createClaimSchema.parse({ ...base, criterionKey: "ac-1", title: "Tests pass" })).toMatchObject({
      criterionKey: "ac-1",
    });
    expect(() => createClaimSchema.parse({ ...base, criterionKey: "", title: "x" })).toThrow();
    expect(() => createClaimSchema.parse({ ...base, criterionKey: "k", title: "x".repeat(201) })).toThrow();
  });

  it("validates evidence records", () => {
    const base = {
      targetId: uuid,
      kind: "ci_result",
      producerPrincipalType: "service",
      producerPrincipalId: "ci-runner",
      objectHash: hash,
      reference: "run/1234",
      trustLevel: "high",
    };
    expect(recordEvidenceSchema.parse(base)).toMatchObject({ kind: "ci_result", trustLevel: "high" });
    expect(recordEvidenceSchema.parse({ ...base, claimId: uuid })).toMatchObject({ claimId: uuid });
    expect(() => recordEvidenceSchema.parse({ ...base, kind: "vibes" })).toThrow();
    expect(() => recordEvidenceSchema.parse({ ...base, producerPrincipalType: "robot" })).toThrow();
    expect(() => recordEvidenceSchema.parse({ ...base, trustLevel: "absolute" })).toThrow();
    expect(() => recordEvidenceSchema.parse({ ...base, objectHash: "z".repeat(64) })).toThrow();
    expect(() => recordEvidenceSchema.parse({ ...base, producerPrincipalType: "agent" })).toThrow();
    expect(() =>
      recordEvidenceSchema.parse({ ...base, producerPrincipalType: "agent", kind: "agent_observation", trustLevel: "high" }),
    ).toThrow();
    expect(
      recordEvidenceSchema.parse({
        ...base,
        producerPrincipalType: "agent",
        kind: "agent_observation",
        trustLevel: "low",
        reference: "session/agent-1",
      }),
    ).toMatchObject({ kind: "agent_observation", trustLevel: "low" });
  });

  it("enforces the waiver rule on verification results", () => {
    const base = { claimId: uuid, verdict: "passed", verifierVersion: "ci.v1", evidenceIds: [uuid] };
    expect(recordVerificationResultSchema.parse(base)).toMatchObject({ verdict: "passed" });

    expect(() =>
      recordVerificationResultSchema.parse({ ...base, evidenceIds: [] }),
    ).toThrow(/at least one evidenceId/);

    expect(() =>
      recordVerificationResultSchema.parse({
        claimId: uuid,
        verdict: "waived",
        verifierVersion: "human.v1",
        evidenceIds: [],
      }),
    ).toThrow(/waiverReference/);

    expect(() =>
      recordVerificationResultSchema.parse({
        ...base,
        waiverReference: "EXCEPTION-1",
      }),
    ).toThrow(/only allowed for waived/);

    expect(() =>
      recordVerificationResultSchema.parse({
        claimId: uuid,
        verdict: "inconclusive",
        verifierVersion: "ci.v1",
        evidenceIds: [],
      }),
    ).toThrow(/at least one evidenceId/);

    const waived = recordVerificationResultSchema.parse({
      claimId: uuid,
      verdict: "waived",
      verifierVersion: "human.v1",
      evidenceIds: [],
      waiverReference: "EXCEPTION-1",
    });
    expect(waived).toMatchObject({ verdict: "waived", waiverReference: "EXCEPTION-1" });

    expect(() =>
      recordVerificationResultSchema.parse({
        ...base,
        evidenceIds: [uuid, uuid],
      }),
    ).toThrow(/duplicates/);
  });
});
