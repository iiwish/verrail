// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { TargetTimelineEventV1 } from "@paperclipai/shared";
import { isUnchangedReconciliation, partitionActivity } from "./TargetActivity";

const event: TargetTimelineEventV1 = { id: "event-1", type: "domain_event", title: "graph.reconciled", aggregateType: "target", aggregateId: "target-1", occurredAt: "2026-09-11T00:00:00Z", detail: null };

describe("activity noise classification", () => {
  it("folds only recognized reconciliations with no transitions", () => {
    expect(isUnchangedReconciliation({ ...event, detail: JSON.stringify({ schemaVersion: 1, activatedNodeIds: [], gateTransitions: [] }) })).toBe(true);
    expect(isUnchangedReconciliation({ ...event, detail: JSON.stringify({ schemaVersion: 1, activatedNodeIds: ["node-1"], gateTransitions: [] }) })).toBe(false);
    expect(isUnchangedReconciliation({ ...event, detail: JSON.stringify({ schemaVersion: 1, activatedNodeIds: [], gateTransitions: [{ from: "ready", to: "pending" }] }) })).toBe(false);
  });
  it("keeps unknown, malformed, and legacy events visible", () => {
    for (const detail of [null, "not JSON", "null", "{}", '{"activatedNodeIds":[]}']) expect(isUnchangedReconciliation({ ...event, detail })).toBe(false);
    expect(isUnchangedReconciliation({ ...event, title: "run.failed", detail: '{"schemaVersion":1,"activatedNodeIds":[],"gateTransitions":[]}' })).toBe(false);
  });
  it("keeps the first legacy snapshot and folds only identical repeated payloads", () => {
    const snapshot = { ...event, detail: '{"schemaVersion":1,"activatedNodeIds":[],"graphRevisionId":"g1"}' };
    const changed = { ...snapshot, id: "changed", detail: '{"schemaVersion":1,"activatedNodeIds":[],"graphRevisionId":"g2"}' };
    const result = partitionActivity([snapshot, { ...snapshot, id: "repeat" }, changed]);
    expect(result.visible.map((item) => item.id)).toEqual(["event-1", "changed"]);
    expect(result.system.map((item) => item.id)).toEqual(["repeat"]);
  });
  it("retains each run's latest heartbeat and never folds failures with it", () => {
    const heartbeat = { ...event, title: "run.event_heartbeat", aggregateId: "run-1" };
    const failure = { ...heartbeat, id: "failed", title: "run.event_failed" };
    const result = partitionActivity([heartbeat, { ...heartbeat, id: "older" }, failure, { ...heartbeat, id: "other", aggregateId: "run-2" }]);
    expect(result.visible.map((item) => item.id)).toEqual(["event-1", "failed", "other"]);
    expect(result.system.map((item) => item.id)).toEqual(["older"]);
  });
});
