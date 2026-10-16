import { describe, expect, it } from "vitest";
import type { TargetWorkItemV1 } from "@paperclipai/shared";
import { graphLayout } from "./TargetWorkGraph";

function item(nodeKey: string, dependencyNodeKeys: string[] = [], kind: TargetWorkItemV1["kind"] = "agent_task"): TargetWorkItemV1 {
  return { id: nodeKey, nodeKey, dependencyNodeKeys, kind, graphRevisionId: "graph-1", stage: "execute", status: "pending", title: nodeKey, responsiblePrincipal: null, completionDefinition: null, updatedAt: "2026-09-11T00:00:00Z" };
}

describe("graphLayout", () => {
  it("positions dependencies before their consumers regardless of source order", () => {
    const nodes = graphLayout([item("review", ["agent", "human"], "review_gate"), item("agent"), item("human", [], "human_task")]);
    expect(nodes[0].position.x).toBeGreaterThan(nodes[1].position.x);
    expect(nodes[1].position.x).toBe(nodes[2].position.x);
    expect(nodes[1].position.y).not.toBe(nodes[2].position.y);
    expect(nodes[2].data.item.kind).toBe("human_task");
  });
  it("retains disconnected nodes and handles missing dependencies and cycles", () => {
    expect(graphLayout([])).toEqual([]);
    const nodes = graphLayout([item("a", ["b"]), item("b", ["a"]), item("c", ["missing"])]);
    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => Number.isFinite(node.position.x))).toBe(true);
  });
});
