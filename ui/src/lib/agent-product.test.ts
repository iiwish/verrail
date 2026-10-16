import { describe, expect, it } from "vitest";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { agentProductSection, agentProductSectionRoute, selectProductAgents, runWorkSummary } from "./agent-product";

const agent = (id: string, overrides: Partial<Agent> = {}) => ({ id, name: id, status: "idle", role: "engineer", adapterType: "codex_local", metadata: null, ...overrides }) as Agent;
const run = (overrides: Partial<HeartbeatRun>) => ({ id: "run-1", ...overrides }) as HeartbeatRun;
describe("agent product model", () => {
  it("groups existing deep links without removing their routes", () => {
    expect(agentProductSection("versions")).toBe("versions");
    expect(agentProductSectionRoute("versions", true)).toBe("versions");
    expect(["skills", "tools"].map(agentProductSection)).toEqual(["capabilities", "capabilities"]);
    expect(["configuration", "secrets", "budget"].map(agentProductSection)).toEqual(["settings", "settings", "settings"]);
    expect(["runs", "audit"].map(agentProductSection)).toEqual(["work", "work"]);
    expect(agentProductSectionRoute("capabilities", true)).toBe("tools");
    expect(agentProductSectionRoute("capabilities", false)).toBe("skills");
  });
  it("keeps pending approval visible and separates attention from paused agents", () => {
    const agents = [agent("active"), agent("error", { status: "error" }), agent("approval", { status: "pending_approval" }), agent("paused", { status: "paused" }), agent("terminated", { status: "terminated" })];
    expect(selectProductAgents(agents, "all", "")).toHaveLength(4);
    expect(selectProductAgents(agents, "error", "").map((entry) => entry.id)).toEqual(["approval", "error"]);
    expect(selectProductAgents(agents, "paused", "").map((entry) => entry.id)).toEqual(["paused"]);
  });
  it("searches responsibility without mutating the API result", () => {
    const agents = [agent("Z", { capabilities: "Frontend accessibility" }), agent("A")];
    expect(selectProductAgents(agents, "all", " ACCESSIBILITY ").map((entry) => entry.id)).toEqual(["Z"]);
    selectProductAgents(agents, "all", "");
    expect(agents.map((entry) => entry.id)).toEqual(["Z", "A"]);
  });
  it("does not present transcript text or success as an acceptance summary", () => {
    expect(runWorkSummary(run({ status: "succeeded", stdoutExcerpt: "Accepted!", resultJson: {} }))).toBeNull();
    expect(runWorkSummary(run({ error: "Permission denied", resultJson: { summary: "Succeeded" } }))).toBe("Permission denied");
  });
});
