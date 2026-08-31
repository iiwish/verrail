import { describe, expect, it } from "vitest";
import { resolveVerrailManagementSection } from "./verrail-section-navigation";

describe("resolveVerrailManagementSection", () => {
  it("recognizes canonical Project, Agent, Infrastructure and Governance routes", () => {
    expect(resolveVerrailManagementSection("/VER/projects", "VER")).toBe("projects");
    expect(resolveVerrailManagementSection("/VER/projects/project-1/targets", "VER")).toBe("projects");
    expect(resolveVerrailManagementSection("/VER/targets/target-1/stages", "VER")).toBe("projects");
    expect(resolveVerrailManagementSection("/VER/agents/definitions", "VER")).toBe("agents");
    expect(resolveVerrailManagementSection("/VER/agents/deployments", "VER")).toBe("agents");
    expect(resolveVerrailManagementSection("/VER/infrastructure/environments", "VER")).toBe("infrastructure");
    expect(resolveVerrailManagementSection("/VER/infrastructure/plugins/example", "VER")).toBe("infrastructure");
    expect(resolveVerrailManagementSection("/VER/governance/attention", "VER")).toBe("governance");
    expect(resolveVerrailManagementSection("/VER/governance/approvals/example", "VER")).toBe("governance");
  });

  it("keeps compatible legacy feature routes inside their Verrail section", () => {
    expect(resolveVerrailManagementSection("/VER/company/settings/instance/environments/new", "VER")).toBe("infrastructure");
    expect(resolveVerrailManagementSection("/VER/company/settings/secrets", "VER")).toBe("infrastructure");
    expect(resolveVerrailManagementSection("/VER/decisions/queues/release", "VER")).toBe("governance");
    expect(resolveVerrailManagementSection("/VER/approvals/pending", "VER")).toBe("governance");
    expect(resolveVerrailManagementSection("/VER/agents/paused", "VER")).toBe("agents");
  });

  it("does not steal Settings-owned or unrelated routes", () => {
    expect(resolveVerrailManagementSection("/VER/company/settings", "VER")).toBeNull();
    expect(resolveVerrailManagementSection("/VER/company/settings/members", "VER")).toBeNull();
    expect(resolveVerrailManagementSection("/VER/company/settings/instance/access", "VER")).toBeNull();
  });
});
