import { describe, expect, it } from "vitest";
import {
  publishAgentVersionSchema,
  recordEvaluationRunSchema,
  reviseDeploymentSchema,
} from "./agent-lifecycle.js";

describe("agent lifecycle validators", () => {
  it("normalizes a published version contract", () => {
    expect(publishAgentVersionSchema.parse({ runtime: "codex-local", model: "gpt", prompt: "deliver" })).toMatchObject({
      skills: [],
      tools: [],
      outputSchema: {},
      capabilityCeiling: [],
      supplyChain: {},
    });
  });

  it("rejects a passing evaluation without passing safety", () => {
    expect(() => recordEvaluationRunSchema.parse({
      candidateAgentVersionId: "11111111-1111-4111-8111-111111111111",
      status: "passed",
      safetyStatus: "failed",
    })).toThrow(/passing safety/);
  });

  it("requires version-bound upgrade and rollback references", () => {
    expect(() => reviseDeploymentSchema.parse({ action: "upgrade" })).toThrow(/agentVersionId/);
    expect(() => reviseDeploymentSchema.parse({ action: "rollback" })).toThrow(/sourceDeploymentRevisionId/);
  });
});
