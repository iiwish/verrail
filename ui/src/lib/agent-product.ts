import { isWorkspaceDirector, type Agent, type HeartbeatRun } from "@paperclipai/shared";

export const AGENT_PRODUCT_SECTIONS = ["overview", "behavior", "capabilities", "versions", "work", "settings"] as const;
export type AgentProductSection = typeof AGENT_PRODUCT_SECTIONS[number];

export function agentProductSection(view: string): AgentProductSection {
  if (view === "versions") return "versions";
  if (view === "instructions") return "behavior";
  if (view === "skills" || view === "tools") return "capabilities";
  if (view === "runs" || view === "audit") return "work";
  if (["configuration", "secrets", "budget"].includes(view)) return "settings";
  return "overview";
}

export function agentProductSectionRoute(section: AgentProductSection, director: boolean): string {
  return { overview: "dashboard", behavior: "instructions", capabilities: director ? "tools" : "skills", versions: "versions", work: "runs", settings: "configuration" }[section];
}

export function agentNeedsAttention(agent: Agent): boolean {
  return agent.status === "error" || agent.status === "pending_approval" || agent.orgChainHealth?.status === "invalid_org_chain";
}

export function selectProductAgents(agents: Agent[], filter: string, search: string, builtInIds: Set<string> = new Set()): Agent[] {
  const needle = search.trim().toLocaleLowerCase();
  return agents.filter((agent) => {
    if (agent.status === "terminated") return false;
    if (filter === "active" && (agent.pausedAt || !["active", "running", "idle"].includes(agent.status))) return false;
    if (filter === "paused" && agent.status !== "paused" && !agent.pausedAt) return false;
    if (filter === "error" && !agentNeedsAttention(agent)) return false;
    if (filter === "builtin" && !isWorkspaceDirector(agent.metadata) && !builtInIds.has(agent.id)) return false;
    return !needle || [agent.name, agent.title, agent.capabilities, agent.adapterType, isWorkspaceDirector(agent.metadata) ? "Director 工作区协调智能体 coordinator" : agent.role]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
  }).sort((a, b) => Number(isWorkspaceDirector(b.metadata)) - Number(isWorkspaceDirector(a.metadata))
    || Number(agentNeedsAttention(b)) - Number(agentNeedsAttention(a)) || a.name.localeCompare(b.name));
}

export function runWorkTitle(run: HeartbeatRun): string | null {
  const context = run.contextSnapshot;
  for (const key of ["taskTitle", "issueTitle", "title"]) {
    const value = context?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function runWorkSummary(run: HeartbeatRun): string | null {
  // Structured summaries only. Raw transcripts remain in the diagnostic detail.
  for (const value of [run.error, run.currentStatusMessage, run.resultJson?.summary, run.resultJson?.message, run.nextAction]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
