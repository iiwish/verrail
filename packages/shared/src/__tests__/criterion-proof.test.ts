import { describe, expect, it } from "vitest";
import { criterionProofContractSchema, criterionProofContextSchema, reviseTargetProofSchema } from "../validators/criterion-proof.js";

describe("mandatory criterion proof contracts", () => {
  it("preserves all compound verification assertions and rejects optional or unknown fields", () => {
    const contract = { schemaVersion: 1, allOf: [{ id: "recovery", kind: "independent_verification", phase: "post_effect", assertions: ["recovery", "secret non-persistence"] }, { id: "receipt", kind: "pull_request_effect", phase: "post_effect" }] };
    expect(criterionProofContractSchema.parse(contract)).toEqual(contract);
    expect(criterionProofContractSchema.safeParse({ ...contract, optional: true }).success).toBe(false);
    expect(criterionProofContractSchema.safeParse({ ...contract, allOf: [{ ...contract.allOf[1], assertions: [] }] }).success).toBe(false);
    expect(criterionProofContractSchema.safeParse({ ...contract, allOf: [...contract.allOf, contract.allOf[0]] }).success).toBe(false);
    expect(criterionProofContractSchema.safeParse({ ...contract, allOf: [{ ...contract.allOf[0], assertions: [] }] }).success).toBe(false);
  });
  it("requires exact context pairing and prohibits arbitrary target rewrites", () => {
    expect(criterionProofContextSchema.safeParse({ requirementId: "late", submissionId: "00000000-0000-4000-8000-000000000001" }).success).toBe(false);
    expect(reviseTargetProofSchema.safeParse({ expectedTargetRevisionId: "00000000-0000-4000-8000-000000000001", title: "Rewritten", criteria: [] }).success).toBe(false);
  });
});
