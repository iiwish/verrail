import { describe, expect, it } from "vitest";
import type { TargetAttentionItemV1, TargetWorkItemV1 } from "@paperclipai/shared";
import { attentionCommand, commandReasonKey, priorityWorkItem } from "./workbench-model";

const attention: TargetAttentionItemV1 = {
  id: "attention", severity: "warning", kind: "action_execution_required", title: "Execute", detail: null,
  workNodeId: null, runId: null, resourceType: "action_request", resourceId: "action-1", createdAt: "2026-09-11",
};
const node = (id: string, status: TargetWorkItemV1["status"]): TargetWorkItemV1 => ({
  id, nodeKey: id, graphRevisionId: "graph-1", kind: "agent_task", stage: "execute", status, title: id,
  responsiblePrincipal: null, dependencyNodeKeys: [], completionDefinition: null, updatedAt: "2026-09-11",
});

describe("workbench action and focus presentation", () => {
  it("does not attach another resource's action permission", () => {
    const command = { id: "execute_action" as const, state: "available" as const, reason: null, resourceId: "action-2" };
    expect(attentionCommand(attention, [command])).toBeUndefined();
    expect(attentionCommand(attention, [{ ...command, resourceId: "action-1" }])).toMatchObject({ resourceId: "action-1" });
    expect(attentionCommand({ ...attention, resourceId: null }, [{ ...command, resourceId: null }])).toBeUndefined();
  });
  it("focuses actionable states or a currently visible attention node rather than array order", () => {
    const nodes = [node("waiting", "pending"), node("stopped", "canceled"), node("active", "running"), node("blocked", "blocked")];
    expect(priorityWorkItem(nodes)?.id).toBe("blocked");
    expect(priorityWorkItem(nodes, [{ ...attention, workNodeId: "active" }])?.id).toBe("active");
    expect(priorityWorkItem(nodes, [{ ...attention, workNodeId: "historical-node" }])?.id).toBe("blocked");
    expect(priorityWorkItem([])).toBeUndefined();
    expect(priorityWorkItem([node("stopped", "canceled"), node("ready", "ready")], [{ ...attention, workNodeId: "stopped" }])?.id).toBe("ready");
  });
  it("maps only exact known user-facing reasons and preserves unknown diagnostics", () => {
    expect(commandReasonKey("An approved ActionRequest and current Acceptance are required.")).toBe("targets.workbench.reasons.approvedAction");
    expect(commandReasonKey("Provider-specific failure 123")).toBeUndefined();
  });
});
