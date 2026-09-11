type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
type Basis = "per_run" | "session_cumulative" | null | undefined;
const keys = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;
const valid = (usage: Usage | null): usage is Usage => usage !== null
  && keys.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0);

/** Provenance is stricter than compatibility billing normalization. */
export function resolveRunUsageProvenance(input: {
  usageBasis: Basis; rawUsage: Usage | null; previousRawUsage: Usage | null;
  previousUsageBasis: Basis; hasPreviousRun: boolean; freshSession: boolean;
}): "per_run" | "session_delta" | null {
  if (!valid(input.rawUsage)) return null;
  if (input.usageBasis === "per_run") return "per_run";
  if (input.usageBasis !== "session_cumulative") return null;
  if (!input.hasPreviousRun && input.freshSession && input.previousRawUsage === null) return "per_run";
  if (!input.hasPreviousRun || input.previousUsageBasis !== "session_cumulative" || !valid(input.previousRawUsage)) return null;
  return keys.every(key => input.rawUsage![key] >= input.previousRawUsage![key]) ? "session_delta" : null;
}
