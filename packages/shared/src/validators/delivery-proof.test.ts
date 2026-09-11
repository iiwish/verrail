import { describe, expect, it } from "vitest";
import { deliveryProofKindForAssertions, DELIVERY_PROOF_ASSERTIONS } from "./delivery-proof.js";

describe("closed composite delivery requirements", () => {
  it.each(["feishu_target", "codex_execution"] as const)("recognizes the complete %s requirement", kind => {
    expect(deliveryProofKindForAssertions([...DELIVERY_PROOF_ASSERTIONS[kind]])).toBe(kind);
    expect(deliveryProofKindForAssertions([...DELIVERY_PROOF_ASSERTIONS[kind]].reverse())).toBe(kind);
  });
  it("does not promote a partial, extended, duplicated, or caller-defined assertion", () => {
    const assertions = [...DELIVERY_PROOF_ASSERTIONS.codex_execution];
    for (const input of [[], assertions.slice(0, 1), [...assertions, "ts_tests"], [assertions[0], assertions[0]],
      ["ts_tests", "ts_typecheck", "ts_build", "go_tests"], assertions.map(value => ` ${value}`),
      [...DELIVERY_PROOF_ASSERTIONS.feishu_target, ...assertions]]) {
      expect(deliveryProofKindForAssertions(input)).toBeNull();
    }
  });
});
