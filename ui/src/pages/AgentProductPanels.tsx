import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isWorkspaceDirector, type Agent, type HeartbeatRun } from "@paperclipai/shared";
import { MessageSquare, Activity, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { agentsApi } from "../api/agents";
import { conversationsApi } from "../api/conversations";
import { agentLifecycleApi } from "../api/agentLifecycle";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef, relativeTime, formatCents } from "../lib/utils";
import { runWorkTitle, runWorkSummary } from "../lib/agent-product";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { AgentStatusBadge, StatusBadge } from "../components/StatusBadge";

function useDirectorRuntime(agent: Agent) {
  const draft = useQuery({ queryKey: queryKeys.agents.directorInstructions(agent.id, agent.companyId), queryFn: () => agentsApi.directorInstructions(agent.id, agent.companyId), enabled: isWorkspaceDirector(agent.metadata) });
  const lifecycle = useQuery({ queryKey: queryKeys.agentLifecycle(agent.companyId), queryFn: () => agentLifecycleApi.get(agent.companyId) });
  const definition = lifecycle.data?.definitions.find((item) => item.compatibilityAgentId === agent.id);
  const primary = definition?.deployments.find((item) => item.isPrimary);
  const version = definition?.versions.find((item) => item.id === primary?.activeRevision?.agentVersionId);
  return { ...draft, isPending: lifecycle.isPending || (isWorkspaceDirector(agent.metadata) && draft.isPending), isError: lifecycle.isError || draft.isError,
    refetch: async () => { await lifecycle.refetch(); return draft.refetch(); },
    data: lifecycle.data ? { runtime: version?.runtime, model: version?.model, available: Boolean(draft.data?.available && primary?.status === "active" && version) } : undefined };
}

function LoadError({ retry }: { retry: () => void }) {
  const { t } = useTranslation();
  return <div className="flex flex-wrap items-center gap-3" role="alert"><p className="text-sm text-destructive">{t("agentProduct.loadFailed")}</p><Button variant="outline" size="sm" onClick={retry}><RefreshCw className="size-4" />{t("common.retry")}</Button></div>;
}

export function AgentProductOverview({ agent, runs, runsLoading, runsError }: {
  agent: Agent; runs: HeartbeatRun[]; runsLoading: boolean; runsError: boolean; retryRuns: () => void;
}) {
  const { t } = useTranslation();
  const director = isWorkspaceDirector(agent.metadata);
  const runtime = useDirectorRuntime(agent);
  const activeRuns = runs.filter((run) => ["running", "queued"].includes(run.status));
  return (
    <div className="min-w-0 space-y-5" data-testid="agent-product-overview">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">{t("agentProduct.responsibility")}</h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{director ? t("agentProduct.directorPurpose") : agent.capabilities || agent.title || t("agentProduct.specialistPurpose")}</p>
        </section>
      <section className="min-w-0 space-y-3 border-t border-border pt-4" data-testid="agent-runtime-summary">
        <h3 className="text-sm font-semibold">{t("agentProduct.runtime")}</h3>
        <dl className="flex flex-wrap items-start gap-x-8 gap-y-3 text-sm">
          <div className="flex items-center gap-2"><dt className="text-xs text-muted-foreground">{t("agentProduct.status")}</dt><dd><AgentStatusBadge status={agent.status} /></dd></div>
          <div className="flex min-w-0 flex-wrap items-center gap-2"><dt className="text-xs text-muted-foreground">{t("agentProduct.runtime")}</dt><dd className="break-words">{runtime.isError ? t("agentProduct.workUnavailable") : runtime.isPending ? t("common.loading") : !runtime.data?.runtime ? t("agentActivation.notActive") : director ? `${runtime.data.runtime === "codex" ? "Codex" : "Claude"} · ${t("directorBehavior.compatibility")}` : getAdapterLabel(runtime.data.runtime)}</dd></div>
          {runtime.data?.model && <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t("agentProduct.model")}</dt><dd className="break-all font-mono text-xs">{runtime.data.model}</dd></div>}
          {director ? <div className="flex items-center gap-2"><dt className="text-xs text-muted-foreground">{t("agentProduct.chatAvailability")}</dt><dd>{runtime.isPending ? t("common.loading") : runtime.isError ? t("agentProduct.workUnavailable") : t(runtime.data?.available ? "agentProduct.available" : "agentProduct.unavailable")}</dd></div> : <>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("agentProduct.currentWork")}</dt><dd className="font-mono">{runsError ? t("agentProduct.workUnavailable") : runsLoading ? t("common.loading") : activeRuns.length}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("agentProduct.monthlySpend")}</dt><dd className="font-mono">{formatCents(agent.spentMonthlyCents)}</dd></div>
          </>}
        </dl>
        {director && runtime.data && <p className="text-xs leading-relaxed text-muted-foreground">{t(runtime.data.runtime === "codex" ? "agentProduct.directorBoundary" : "agentProduct.textOnlyBoundary")}</p>}
        {runtime.isError && director && <LoadError retry={() => void runtime.refetch()} />}
        {(agent.errorReason || agent.pauseReason) && <p className="break-words text-sm text-destructive" role="status">{agent.errorReason || agent.pauseReason}</p>}
      </section>
    </div>
  );
}

export function AgentWorkRecords({ agent, runs, runsLoading, runsError, retryRuns }: {
  agent: Agent; runs: HeartbeatRun[]; runsLoading: boolean; runsError: boolean; retryRuns: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState(isWorkspaceDirector(agent.metadata) ? "conversations" : "executions");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(20);
  const active = useQuery({ queryKey: ["agent-conversations", agent.companyId, agent.id, "active"], queryFn: () => conversationsApi.list(agent.companyId, { agentId: agent.id }), staleTime: 15_000 });
  const archived = useQuery({ queryKey: ["agent-conversations", agent.companyId, agent.id, "archived"], queryFn: () => conversationsApi.list(agent.companyId, { agentId: agent.id, status: "archived" }), staleTime: 15_000 });
  const rows = (kind === "conversations"
    ? [...(active.data ?? []), ...(archived.data ?? [])].map((conversation) => ({ id: conversation.id, kind: "conversations", title: conversation.title, summary: null as string | null, status: conversation.status, time: conversation.lastMessageAt ?? conversation.updatedAt, href: `/chat/${conversation.id}` }))
    : runs.map((run) => ({ id: run.id, kind: "executions", title: runWorkTitle(run) || t("agentProduct.executionNamed", { id: run.id.slice(0, 8) }), summary: runWorkSummary(run), status: run.status, time: run.startedAt ?? run.createdAt, href: `/agents/${agentRouteRef(agent)}/runs/${run.id}` })))
    .filter((row) => (status === "all" || row.status === status) && (!search.trim() || `${row.title} ${row.summary ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const loading = (kind !== "executions" && (active.isPending || archived.isPending)) || (kind !== "conversations" && runsLoading);
  const failed = (kind !== "executions" && (active.isError || archived.isError)) || (kind !== "conversations" && runsError);
  return (
    <div className="min-w-0 space-y-4" data-testid="agent-work-records">
      <div className="flex flex-wrap items-center justify-between gap-3">
      <Tabs value={kind} onValueChange={(value) => { setKind(value); setStatus("all"); setSearch(""); setLimit(20); }}>
        <TabsList aria-label={t("agentProduct.workType")}>
          <TabsTrigger value="executions"><Activity className="size-4" />{t("agentProduct.executionRecords")}</TabsTrigger>
          <TabsTrigger value="conversations"><MessageSquare className="size-4" />{t("agentProduct.participatedConversations")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <Link to={`/agents/${agentRouteRef(agent)}/audit`} className="text-xs text-muted-foreground hover:text-foreground">{t("agentProduct.views.audit")}</Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" aria-label={t("agentProduct.status")} value={status} onChange={(event) => { setStatus(event.target.value); setLimit(20); }}>
          <option value="all">{t("agentProduct.allStatuses")}</option>
          {(kind === "conversations" ? ["active", "archived"] : ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]).map((value) => <option key={value} value={value}>{t(`agentProduct.recordStatuses.${value}`)}</option>)}
        </select>
        <div className="relative w-full sm:w-64"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(20); }} placeholder={t(kind === "conversations" ? "agentProduct.searchConversations" : "agentProduct.searchExecutions")} aria-label={t("agentProduct.searchWork")} /></div>
      </div>
      {failed && <LoadError retry={() => { if (kind === "executions") retryRuns(); else { void active.refetch(); void archived.refetch(); } }} />}
      {loading && <p className="text-sm text-muted-foreground" role="status">{t("common.loading")}</p>}
      {!loading && !failed && rows.length === 0 && <p className="py-8 text-sm text-muted-foreground">{t(search || status !== "all" ? "agentProduct.noWorkMatches" : kind === "conversations" ? "agentProduct.noConversations" : "agentProduct.noExecutions")}</p>}
      <div className="divide-y divide-border">
        {rows.slice(0, limit).map((row) => <Link key={`${row.kind}-${row.id}`} to={row.href} className="flex items-start gap-3 py-3 text-inherit no-underline transition-colors hover:bg-accent/40">
          <span className="pt-0.5 text-muted-foreground">{row.kind === "conversations" ? <MessageSquare className="size-4" /> : <Activity className="size-4" />}</span>
          <div className="min-w-0 flex-1 space-y-1"><div className="break-words text-sm font-medium">{row.title}</div>{row.summary && <p className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{row.summary}</p>}<span className="text-xs text-muted-foreground">{t(`agentProduct.${row.kind}`)} · {relativeTime(row.time)}</span></div>
          <span className="shrink-0">{row.kind === "executions" ? <StatusBadge status={row.status} /> : <span className="text-xs text-muted-foreground">{t(row.status === "archived" ? "agentProduct.archived" : "agentProduct.conversation")}</span>}</span>
        </Link>)}
      </div>
      {rows.length > limit && <Button variant="ghost" onClick={() => setLimit((value) => value + 20)}>{t("agentProduct.showMore")}</Button>}
      {kind === "executions" && rows.length > 0 && <p className="text-xs text-muted-foreground">{t("agentProduct.executionBoundary")}</p>}
    </div>
  );
}

export function DirectorCapabilities({ agent, skills = false }: { agent: Agent; skills?: boolean }) {
  const { t } = useTranslation();
  const runtime = useDirectorRuntime(agent);
  const snapshot = useQuery({ queryKey: queryKeys.agents.skills(agent.id), queryFn: () => agentsApi.skills(agent.id, agent.companyId), enabled: skills });
  if (runtime.isPending) return <p role="status" className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (runtime.isError || !runtime.data) return <LoadError retry={() => void runtime.refetch()} />;
  const available = runtime.data.available;
  const tools = available && runtime.data.runtime === "codex";
  return (
    <section className="max-w-4xl space-y-5" data-testid="director-capabilities">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t(skills ? "agentProduct.configuredSkills" : "agentProduct.availableCapabilities")}</h3><span className="text-xs text-muted-foreground">{runtime.data.runtime ? `${runtime.data.runtime === "codex" ? "Codex" : "Claude"} · ${t("directorBehavior.compatibility")}` : t("agentActivation.notActive")}</span></div>
      {skills ? <>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("agentProduct.directorSkillsBoundary")}</p>
        {snapshot.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("common.loading")}</p> : snapshot.isError ? <LoadError retry={() => void snapshot.refetch()} /> : <div className="divide-y divide-border">
          {snapshot.data?.entries.filter((entry) => entry.desired).map((entry) => <div key={entry.key} className="flex items-center justify-between gap-3 py-3"><code className="break-all text-xs">{entry.runtimeName || entry.key}</code><span className="shrink-0 text-xs text-muted-foreground">{t("agentProduct.notLoadedInChat")}</span></div>)}
          {!snapshot.data?.entries.some((entry) => entry.desired) && <p className="py-4 text-sm text-muted-foreground">{t("agentProduct.noConfiguredSkills")}</p>}
        </div>}
      </> : <>
        {!available && <p className="text-sm text-destructive" role="status">{t("agentProduct.unavailable")}</p>}
        <div className="divide-y divide-border">
          {[["discussion", available, "available"], ["targetRead", tools, "readOnly"], ["contextSwitch", tools, "available"], ["targetProposals", tools, "confirmation"], ["deliveryExecution", false, "notConnected"]].map(([key, enabled, state]) => <div key={String(key)} className="flex items-start gap-3 py-4">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-1"><h4 className="text-sm font-medium">{t(`agentProduct.capabilities.${key}`)}</h4><p className="text-xs leading-relaxed text-muted-foreground">{t(`agentProduct.capabilities.${key}Detail`)}</p></div>
            <span className="shrink-0 text-xs text-muted-foreground">{t(`agentProduct.${enabled ? state : "notConnected"}`)}</span>
          </div>)}
        </div>
      </>}
    </section>
  );
}
