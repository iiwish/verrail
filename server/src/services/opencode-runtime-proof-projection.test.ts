import { expect, it } from "vitest";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { syntheticCandidateWitnesses } from "../__tests__/helpers/opencode-candidate-witness.js";
import { projectOpenCodeRuntimeProof } from "./opencode-runtime-proof-projection.js";

it("preserves candidate/identity/signature references while keeping large script sets outside the closed payload", () => {
  const runtime = syntheticCandidateWitnesses(4000), projected = projectOpenCodeRuntimeProof(runtime);
  expect(Buffer.byteLength(canonicalJson(runtime))).toBeGreaterThan(40_000);
  expect(Buffer.byteLength(canonicalJson(projected))).toBeLessThan(12_000);
  expect(projected.witnesses.map(item => item.observation.scriptCount)).toEqual([4000, 0, 4000, 0]);
  expect(projected.witnesses[0]!.observation.observationSha256).toBe(runtime.witnesses[0]!.observation.sha256);
  expect(projected.witnesses[3]!.executionIdentity).toEqual(runtime.witnesses[3]!.executionIdentity);
  expect(projected.witnesses[3]!.termination).toEqual(runtime.witnesses[3]!.termination);
  expect(projected.witnesses.map(item => item.envelopeRef)).toEqual(runtime.witnesses.map(item => item.envelopeRef));
  expect(canonicalJson(projected)).not.toContain("component-3999.mjs");
});
it("does not summarize a witness without a valid immutable archive reference", () => {
  const runtime = syntheticCandidateWitnesses();
  runtime.witnesses[0]!.envelopeRef.contentRef = "private-witness:sha256:" + "f".repeat(64);
  expect(() => projectOpenCodeRuntimeProof(runtime)).toThrow();
  delete (runtime.witnesses[0] as { envelopeRef?: unknown }).envelopeRef;
  expect(() => projectOpenCodeRuntimeProof(runtime)).toThrow();
});
