import { describe, expect, it } from "vitest";
import {
  acceptSubmissionSchema,
  adjudicationIdempotencyKeySchema,
  createSubmissionSchema,
  deriveAcceptanceValidity,
  recordDeliveryReviewSchema,
} from "./adjudication.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const otherUuid = "22222222-2222-4222-8222-222222222222";

describe("adjudication validators", () => {
  it("reuses the target idempotency key rules", () => {
    expect(adjudicationIdempotencyKeySchema.parse("adjudication:create:1234")).toBe(
      "adjudication:create:1234",
    );
    expect(adjudicationIdempotencyKeySchema.safeParse("short").success).toBe(false);
  });

  it("validates submission creation", () => {
    const base = {
      targetId: uuid,
      targetRevisionId: otherUuid,
      artifactRevisionIds: [uuid],
      verificationResultIds: [otherUuid],
      commitRef: "git:abc123",
    };
    expect(createSubmissionSchema.parse(base)).toMatchObject({
      targetId: uuid,
      artifactRevisionIds: [uuid],
      verificationResultIds: [otherUuid],
      commitRef: "git:abc123",
    });
    // verificationResultIds defaults to an empty set
    expect(
      createSubmissionSchema.parse({ targetId: uuid, targetRevisionId: otherUuid, artifactRevisionIds: [uuid] }),
    ).toMatchObject({ verificationResultIds: [] });

    expect(() => createSubmissionSchema.parse({ ...base, artifactRevisionIds: [] })).toThrow();
    expect(() =>
      createSubmissionSchema.parse({ ...base, artifactRevisionIds: Array.from({ length: 101 }, () => uuid) }),
    ).toThrow();
    expect(() =>
      createSubmissionSchema.parse({ ...base, verificationResultIds: Array.from({ length: 201 }, () => uuid) }),
    ).toThrow();
    expect(() => createSubmissionSchema.parse({ ...base, artifactRevisionIds: [uuid, uuid] })).toThrow(
      /duplicates/,
    );
    expect(() => createSubmissionSchema.parse({ ...base, verificationResultIds: [otherUuid, otherUuid] })).toThrow(
      /duplicates/,
    );
    expect(() => createSubmissionSchema.parse({ ...base, commitRef: "x".repeat(501) })).toThrow();
    expect(() => createSubmissionSchema.parse({ ...base, environmentSummary: "x".repeat(2001) })).toThrow();
    expect(() => createSubmissionSchema.parse({ ...base, notes: "x".repeat(2001) })).toThrow();
    expect(() => createSubmissionSchema.parse({ ...base, extra: 1 })).toThrow();
    expect(createSubmissionSchema.parse({ ...base, commitRef: null })).toMatchObject({ commitRef: null });
  });

  it("validates delivery reviews and enforces a human reviewer on the wire", () => {
    const base = {
      submissionId: uuid,
      reviewerPrincipalType: "user",
      reviewerPrincipalId: "reviewer-1",
      verdict: "approved",
      unprovenItems: [],
    };
    expect(recordDeliveryReviewSchema.parse(base)).toMatchObject({ verdict: "approved" });
    expect(
      recordDeliveryReviewSchema.parse({ ...base, risks: "ci flakiness", comments: "looks good" }),
    ).toMatchObject({ risks: "ci flakiness", comments: "looks good" });

    // The G2 authority model: reviewer is a human workspace member.
    expect(() => recordDeliveryReviewSchema.parse({ ...base, reviewerPrincipalType: "agent" })).toThrow();
    expect(() => recordDeliveryReviewSchema.parse({ ...base, reviewerPrincipalId: "" })).toThrow();
    expect(() => recordDeliveryReviewSchema.parse({ ...base, verdict: "maybe" })).toThrow();
    expect(() =>
      recordDeliveryReviewSchema.parse({ ...base, unprovenItems: Array.from({ length: 21 }, () => "x") }),
    ).toThrow();
    expect(() => recordDeliveryReviewSchema.parse({ ...base, unprovenItems: ["x".repeat(501)] })).toThrow();
    expect(() => recordDeliveryReviewSchema.parse({ ...base, risks: "x".repeat(2001) })).toThrow();
    expect(() => recordDeliveryReviewSchema.parse({ ...base, comments: "x".repeat(4001) })).toThrow();
    expect(() => recordDeliveryReviewSchema.parse({ ...base, extra: 1 })).toThrow();
  });

  it("validates acceptance submission references", () => {
    expect(acceptSubmissionSchema.parse({ submissionId: uuid, reviewId: otherUuid })).toMatchObject({
      submissionId: uuid,
      reviewId: otherUuid,
    });
    expect(() => acceptSubmissionSchema.parse({ submissionId: "not-a-uuid", reviewId: otherUuid })).toThrow();
    expect(() => acceptSubmissionSchema.parse({ submissionId: uuid })).toThrow();
    expect(() => acceptSubmissionSchema.parse({ submissionId: uuid, reviewId: otherUuid, extra: 1 })).toThrow();
  });

  it("derives acceptance validity per ontology invariant 10", () => {
    expect(deriveAcceptanceValidity(true, true)).toEqual({ validity: "valid", invalidReason: null });
    expect(deriveAcceptanceValidity(false, true)).toEqual({
      validity: "invalid",
      invalidReason: "superseded_submission",
    });
    expect(deriveAcceptanceValidity(true, false)).toEqual({
      validity: "invalid",
      invalidReason: "target_revision_changed",
    });
    // Both facts changed: supersession takes precedence (documented rule).
    expect(deriveAcceptanceValidity(false, false)).toEqual({
      validity: "invalid",
      invalidReason: "superseded_submission",
    });
  });
});
