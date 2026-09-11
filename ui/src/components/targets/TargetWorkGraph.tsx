import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ReactFlow, Handle, Position, Controls, MarkerType, type Node, type NodeProps } from "@xyflow/react";
import { Bot, UserRound, ShieldCheck, Workflow, X } from "lucide-react";
import type { TargetWorkItemV1, TargetGraphSummaryV1 } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";

type WorkNode = Node<{ item: TargetWorkItemV1 }, "work">;
const icons = { agent_task: Bot, human_task: UserRound, integration_task: Workflow, decision_gate: UserRound, review_gate: ShieldCheck, acceptance_gate: ShieldCheck, policy_gate: ShieldCheck };

function GraphNode({ data, selected }: NodeProps<WorkNode>) {
  const { t } = useTranslation();
  const { item } = data;
  const Icon = icons[item.kind];
  return <div className="target-graph-node" data-selected={selected} data-status={item.status}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-4 w-4 shrink-0" /><span>{t(`targets.graph.kinds.${item.kind}`)}</span></div>
    <p className="line-clamp-2 break-words text-sm font-medium" title={item.title}>{item.title}</p>
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t(`targets.stageNames.${item.stage}`)}</span><span>{t(`targets.graph.states.${item.status}`)}</span></div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
const nodeTypes = { work: GraphNode };

export function graphLayout(items: TargetWorkItemV1[]) {
  const keys = new Set(items.map((item) => item.nodeKey));
  const levels = new Map<string, number>();
  const pending = [...items];
  while (pending.length) {
    const index = pending.findIndex((item) => item.dependencyNodeKeys.every((key) => !keys.has(key) || levels.has(key)));
    // Malformed cyclic input remains inspectable without looping or inventing edges.
    const item = pending.splice(index < 0 ? 0 : index, 1)[0];
    levels.set(item.nodeKey, Math.max(0, ...item.dependencyNodeKeys.map((key) => (levels.get(key) ?? -1) + 1)));
  }
  const rows = new Map<number, number>();
  return items.map((item) => {
    const column = levels.get(item.nodeKey)!;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { id: item.id, type: "work" as const, position: { x: column * 320, y: row * 180 }, data: { item } };
  });
}

export function TargetWorkGraph({ items, graph, inspector }: { items: TargetWorkItemV1[]; graph: TargetGraphSummaryV1 | null; inspector?: (item: TargetWorkItemV1) => ReactNode }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const onSelectionChange = useCallback(({ nodes: selection }: { nodes: WorkNode[] }) => {
    setSelectedId(selection[0]?.id ?? null);
  }, []);
  const nodes = useMemo(() => graphLayout(items), [items]);
  const selected = items.find((item) => item.id === selectedId);
  const edges = useMemo(() => items.flatMap((item) => item.dependencyNodeKeys.flatMap((key) => {
    const source = items.find((candidate) => candidate.nodeKey === key && candidate.graphRevisionId === item.graphRevisionId);
    return source ? [{ id: `${source.id}-${item.id}`, source: source.id, target: item.id, markerEnd: { type: MarkerType.ArrowClosed } }] : [];
  })), [items]);
  return <section aria-label={t("targets.tabs.work")} className="space-y-3">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t("targets.tabs.work")}</h3><span className="text-xs text-muted-foreground">{t("targets.graph.summary", { count: items.length, revision: graph?.revisionNumber ?? "—" })}</span></div>
    {items.length ? <div className="target-work-graph">
      <ReactFlow key={JSON.stringify(items)} defaultNodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} maxZoom={1.5} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} onSelectionChange={onSelectionChange} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)} aria-label={t("targets.tabs.work")} ariaLabelConfig={{ "controls.zoomIn.ariaLabel": t("targets.graph.zoomIn"), "controls.zoomOut.ariaLabel": t("targets.graph.zoomOut"), "controls.fitView.ariaLabel": t("targets.graph.fitView") }}>
        <Controls showInteractive={false} aria-label={t("targets.graph.controls")} />
      </ReactFlow>
    </div> : <p className="border-y border-border py-5 text-sm text-muted-foreground">{t("targets.emptyTabs.work")}</p>}
    {selected ? <div className="space-y-3 border-y border-border py-3">
      <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">{selected.title}</h4><Button size="icon" variant="ghost" onClick={() => setSelectedId(null)} aria-label={t("common.close")} title={t("common.close")}><X className="h-4 w-4" /></Button></div>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-muted-foreground">{t("targets.graph.kind")}</dt><dd>{t(`targets.graph.kinds.${selected.kind}`)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t("targets.graph.owner")}</dt><dd className="break-all">{selected.responsiblePrincipal?.principalId ?? t("targets.unassigned")}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t("targets.graph.dependencies")}</dt><dd className="break-words">{selected.dependencyNodeKeys.map((key) => items.find((item) => item.nodeKey === key)?.title ?? key).join(", ") || t("targets.graph.none")}</dd></div>
      </dl>
      {selected.completionDefinition ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{selected.completionDefinition}</p> : null}
      {inspector?.(selected)}
    </div> : null}
  </section>;
}
