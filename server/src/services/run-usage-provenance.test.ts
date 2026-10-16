import { describe, expect, it } from "vitest";
import { resolveRunUsageProvenance } from "./run-usage-provenance.js";

const rawUsage = { inputTokens: 100, cachedInputTokens: 30, outputTokens: 10 };
const base = { usageBasis: "session_cumulative" as const, rawUsage, previousRawUsage: null, previousUsageBasis: null, hasPreviousRun: false, freshSession: true };
describe("normal execution usage provenance", () => {
  it("attributes explicit cumulative totals to a proven fresh first session", () => {
    expect(resolveRunUsageProvenance(base)).toBe("per_run");
  });
  it("retains explicit per-run adapter semantics for reused sessions", () => {
    expect(resolveRunUsageProvenance({ ...base, usageBasis: "per_run", freshSession: false })).toBe("per_run");
  });
  it("derives a delta only from an explicit compatible cumulative baseline", () => {
    expect(resolveRunUsageProvenance({ ...base, freshSession: false, hasPreviousRun: true, previousUsageBasis: "session_cumulative",
      previousRawUsage: { inputTokens: 90, cachedInputTokens: 20, outputTokens: 5 } })).toBe("session_delta");
  });
  it.each([
    { usageBasis: null }, { freshSession: false }, { hasPreviousRun: true }, { rawUsage: null },
    { rawUsage: { ...rawUsage, inputTokens: -1 } }, { rawUsage: { ...rawUsage, outputTokens: 0.5 } },
    { rawUsage: { ...rawUsage, inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { previousRawUsage: rawUsage, previousUsageBasis: "per_run", hasPreviousRun: true, freshSession: false },
    { previousRawUsage: rawUsage, previousUsageBasis: null, hasPreviousRun: true, freshSession: false },
    { previousRawUsage: { ...rawUsage, cachedInputTokens: 40 }, previousUsageBasis: "session_cumulative", hasPreviousRun: true, freshSession: false },
  ])("does not invent provenance for %j", patch => {
    expect(resolveRunUsageProvenance({ ...base, ...patch } as Parameters<typeof resolveRunUsageProvenance>[0])).toBeNull();
  });
});
