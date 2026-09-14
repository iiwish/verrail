import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReactFlow, Handle, Position, Controls, MarkerType, type ReactFlowInstance, type Node, type NodeProps } from "@xyflow/react";
import { Bot, UserRound, ShieldCheck, Workflow, X, Scan, Focus, GitBranchPlus, Maximize, Minimize } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import type { TargetWorkItemV1, TargetGraphSummaryV1, TargetWorkspaceV1 } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { priorityWorkItem } from "./workbench-model";

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

export function TargetWorkGraph({ items: currentItems, graph: currentGraph, versions = [], onCreateRevision, inspector, selectedId, onSelect, priorityId, ownerName }: {
  items: TargetWorkItemV1[];
  graph: TargetGraphSummaryV1 | null;
  versions?: TargetWorkspaceV1["graphVersions"];
  onCreateRevision?: () => void;
  inspector?: (item: TargetWorkItemV1, closeExpanded: () => void) => ReactNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  priorityId?: string;
  ownerName: (item: TargetWorkItemV1) => string;
}) {
  const { t } = useTranslation();
  const [versionId, setVersionId] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const version = versions.find((revision) => revision.id === (versionId || currentGraph?.activeGraphRevisionId));
  const historical = Boolean(version && version.id !== currentGraph?.activeGraphRevisionId);
  const items = version?.work ?? currentItems;
  const graph = version && currentGraph ? { ...currentGraph, activeGraphRevisionId: version.id, revisionNumber: version.revisionNumber } : currentGraph;
  const instance = useRef<ReactFlowInstance<WorkNode> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const selectorRef = useRef<HTMLSelectElement>(null);
  const nodes = useMemo(() => graphLayout(items).map((node) => ({ ...node, selected: node.id === selectedId, ariaLabel: `${node.data.item.title} · ${t(`targets.graph.states.${node.data.item.status}`)}` })), [items, selectedId, t]);
  const selected = items.find((item) => item.id === selectedId);
  const focusId = items.some((item) => item.id === priorityId) ? priorityId : priorityWorkItem(items)?.id;
  const focusNeighborhood = items.filter((item) => {
    const current = items.find((node) => node.id === focusId);
    return current && item.graphRevisionId === current.graphRevisionId && (item.id === focusId || current.dependencyNodeKeys.includes(item.nodeKey) || item.dependencyNodeKeys.includes(current.nodeKey));
  }).map((item) => ({ id: item.id }));
  const focusNode = (id: string | undefined) => {
    if (id) void instance.current?.fitView({ nodes: [{ id }], minZoom: 1, maxZoom: 1 });
  };
  useEffect(() => {
    if (!selectedId || !canvasRef.current) return;
    let frame = 0;
    // The inspector changes canvas width; center after React Flow measures it.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => focusNode(selectedId));
    });
    observer.observe(canvasRef.current);
    focusNode(selectedId);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [selectedId, fullscreen]);
  const edges = useMemo(() => items.flatMap((item) => item.dependencyNodeKeys.flatMap((key) => {
    const source = items.find((candidate) => candidate.nodeKey === key && candidate.graphRevisionId === item.graphRevisionId);
    return source ? [{ id: `${source.id}-${item.id}`, source: source.id, target: item.id, className: selectedId && (source.id === selectedId || item.id === selectedId) ? "target-graph-edge-active" : undefined, markerEnd: { type: MarkerType.ArrowClosed } }] : [];
  })), [items, selectedId]);
  const sectionRef = useRef<HTMLElement>(null);
  const closeInspector = () => {
    selectorRef.current?.focus();
    onSelect(null);
  };
  const content = <section ref={sectionRef} aria-label={t("targets.tabs.work")} className="target-graph-workspace space-y-3" onKeyDown={(event) => { if (event.key === "Escape" && selected) { event.stopPropagation(); closeInspector(); } }}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-3"><h3 className="text-sm font-semibold">{t("targets.tabs.work")}</h3><span className="text-xs text-muted-foreground">{versions.length ? t("targets.graph.nodeCount", { count: items.length }) : t("targets.graph.summary", { count: items.length, revision: graph?.revisionNumber ?? "—" })}</span></div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
        {onCreateRevision ? <Button variant="ghost" size="icon-sm" onClick={() => { setFullscreen(false); onCreateRevision(); }} title={t("targets.graph.newVersion")} aria-label={t("targets.graph.newVersion")}><GitBranchPlus className="h-4 w-4" /></Button> : null}
        {versions.length ? <select aria-label={t("targets.graph.version")} className="h-8 min-w-0 max-w-52 rounded-md border border-input bg-background px-2 text-xs" value={versionId || currentGraph?.activeGraphRevisionId || ""} onChange={(event) => { setVersionId(event.target.value); onSelect(null); }}>
          {!currentGraph?.activeGraphRevisionId && !versionId ? <option value="">{t("targets.graph.noActiveVersion")}</option> : null}
          {versions.map((revision) => <option key={revision.id} value={revision.id}>r{revision.revisionNumber} · {t(revision.id === currentGraph?.activeGraphRevisionId ? "targets.graph.versionActive" : revision.status === "draft" ? "targets.graph.versionDraft" : "targets.graph.versionHistory")}</option>)}
        </select> : null}
        {items.length ? <>
        <select ref={selectorRef} aria-label={t("targets.graph.selectNode")} className="h-8 min-w-0 max-w-52 rounded-md border border-input bg-background px-2 text-xs" value={selected?.id ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
          <option value="">{t("targets.graph.selectNode")}</option>
          {items.map((item) => <option key={item.id} value={item.id}>{item.title} · {t(`targets.graph.states.${item.status}`)}</option>)}
        </select>
        <Button size="icon-sm" variant="ghost" title={t("targets.graph.focusCurrent")} aria-label={t("targets.graph.focusCurrent")} onClick={() => selected ? focusNode(selected.id) : void instance.current?.fitView({ nodes: focusNeighborhood, minZoom: 0.85, maxZoom: 1, padding: 0.1 })}><Focus className="h-4 w-4" /></Button>
        <Button size="icon-sm" variant="ghost" title={t("targets.graph.fitView")} aria-label={t("targets.graph.fitView")} onClick={() => void instance.current?.fitView({ minZoom: 0.2, maxZoom: 1, padding: 0.1 })}><Scan className="h-4 w-4" /></Button>
        </> : null}
        <Button size="icon-sm" variant="ghost" title={t(fullscreen ? "targets.graph.exitFullscreen" : "targets.graph.fullscreen")} aria-label={t(fullscreen ? "targets.graph.exitFullscreen" : "targets.graph.fullscreen")} onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}</Button>
      </div>
    </div>
    {version ? <p className="text-xs text-muted-foreground">{t("targets.graph.createdAt")} · {formatDateTime(version.createdAt)}</p> : null}
    {historical ? <p className="text-xs text-muted-foreground">{t("targets.graph.versionReadOnly")}</p> : null}
    {items.length ? <div className="target-graph-container"><div className="target-work-surface" data-inspecting={Boolean(selected)}>
      <div ref={canvasRef} className="target-work-graph">
      <ReactFlow<WorkNode> key={graph?.activeGraphRevisionId ?? graph?.workGraphId} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ nodes: focusNeighborhood, minZoom: 0.85, maxZoom: 1, padding: 0.1 }} minZoom={0.2} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} onInit={(flow) => { instance.current = flow; }} onNodesChange={(changes) => { const selection = changes.find((change) => change.type === "select" && change.selected); if (selection?.type === "select") onSelect(selection.id); }} onNodeClick={(_event, node) => onSelect(node.id)} onPaneClick={() => onSelect(null)} aria-label={t("targets.tabs.work")} ariaLabelConfig={{ "controls.zoomIn.ariaLabel": t("targets.graph.zoomIn"), "controls.zoomOut.ariaLabel": t("targets.graph.zoomOut"), "controls.fitView.ariaLabel": t("targets.graph.fitView") }}>
        <Controls showFitView={false} showInteractive={false} aria-label={t("targets.graph.controls")} />
      </ReactFlow>
      </div>
    {selected ? <aside className="target-graph-inspector space-y-4" aria-label={t("targets.graph.nodeDetails")}>
      <div className="flex items-start justify-between gap-3"><h4 className="min-w-0 break-words text-sm font-semibold">{selected.title}</h4><Button size="icon-sm" variant="ghost" onClick={closeInspector} aria-label={t("common.close")} title={t("common.close")}><X className="h-4 w-4" /></Button></div>
      <p className="text-sm font-medium">{t(`targets.graph.states.${selected.status}`)}</p>
      <dl className="grid gap-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">{t("targets.graph.kind")}</dt><dd>{t(`targets.graph.kinds.${selected.kind}`)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t("targets.graph.owner")}</dt><dd className="break-words">{ownerName(selected)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t("targets.graph.dependencies")}</dt><dd className="space-y-1">{selected.dependencyNodeKeys.length ? selected.dependencyNodeKeys.map((key) => {
          const dependency = items.find((item) => item.nodeKey === key && item.graphRevisionId === selected.graphRevisionId);
          return dependency ? <button key={key} className="block w-full break-words text-left text-sm underline decoration-border underline-offset-4 hover:text-primary" onClick={() => onSelect(dependency.id)}>{dependency.title} · {t(`targets.graph.states.${dependency.status}`)}</button> : <span key={key} className="block break-all">{key}</span>;
        }) : t("targets.graph.none")}</dd></div>
      </dl>
      {!historical ? inspector?.(selected, () => setFullscreen(false)) : null}
      {selected.completionDefinition ? <details className="text-sm"><summary className="cursor-pointer font-medium">{t("targets.graph.completion")}</summary><p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{selected.completionDefinition}</p></details> : null}
      {selected.responsiblePrincipal ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("targets.delivery.auditDetails")}</summary><p className="mt-2 break-all font-mono">{selected.responsiblePrincipal.principalType} · {selected.responsiblePrincipal.principalId}</p></details> : null}
    </aside> : null}
    </div></div> : <p className="py-5 text-sm text-muted-foreground">{t("targets.emptyTabs.work")}</p>}
  </section>;
  return fullscreen ? <Dialog open onOpenChange={setFullscreen}><DialogContent className="target-graph-dialog" showCloseButton={false} aria-describedby={undefined}><DialogTitle className="sr-only">{t("targets.tabs.work")}</DialogTitle>{content}</DialogContent></Dialog> : content;
}
