import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { isWorkspaceDirector } from "@paperclipai/shared";
import { ArrowUpRight, Bot, MessageSquare, Plus, RefreshCw, Search, X, AlertCircle } from "lucide-react";
import { agentsApi } from "../api/agents";
import { builtInAgentsApi, type BuiltInAgentState } from "../api/builtInAgents";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { AgentStatusBadge } from "../components/StatusBadge";
import { AgentIcon } from "../components/AgentIconPicker";
import { StarToggle } from "../components/StarToggle";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { agentUrl, agentRouteRef, relativeTime } from "../lib/utils";
import { agentNeedsAttention, selectProductAgents } from "../lib/agent-product";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isStarred, useResourceMembershipMutation, useResourceMemberships } from "../hooks/useResourceMemberships";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { useTranslation } from "@/i18n";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

const ConfigureBuiltInAgentModal = lazy(() => import("../components/ConfigureBuiltInAgentModal").then((m) => ({ default: m.ConfigureBuiltInAgentModal })));
export const AGENT_FILTER_TABS = ["all", "active", "paused", "error", "builtin"] as const;

export function Agents() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const requested = location.pathname.split("/").pop() ?? "all";
  const tab = AGENT_FILTER_TABS.includes(requested as typeof AGENT_FILTER_TABS[number]) ? requested : "all";
  const [search, setSearch] = useState("");
  const [configureState, setConfigureState] = useState<BuiltInAgentState | null>(null);
  const memberships = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const query = useQuery({ queryKey: queryKeys.agents.list(selectedCompanyId!), queryFn: () => agentsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const settings = useQuery({ queryKey: queryKeys.instance.settings, queryFn: () => instanceSettingsApi.get(), enabled: !!selectedCompanyId });
  const builtIns = useQuery({ queryKey: queryKeys.builtInAgents.list(selectedCompanyId!), queryFn: () => builtInAgentsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId && settings.data?.experimental.enableBuiltInAgents === true });
  const liveQueryKey = [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"];
  const sharedLive = useSharedPollingQuery({ companyId: selectedCompanyId, resourceKey: "live-runs:agents-page", queryKey: liveQueryKey, enabled: !!selectedCompanyId, refetchInterval: 15_000, leaderOnly: true });
  const live = useQuery({ queryKey: liveQueryKey, queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!), enabled: sharedLive.enabled, refetchInterval: sharedLive.refetchInterval });
  usePublishSharedQueryData(sharedLive, live.data, live.dataUpdatedAt);
  const builtInIds = useMemo(() => new Set((builtIns.data ?? []).flatMap((entry) => entry.agentId ? [entry.agentId] : [])), [builtIns.data]);
  const agents = query.data ?? [];
  const filtered = selectProductAgents(agents, tab, search, builtInIds);
  const tabs = AGENT_FILTER_TABS.filter((value) => value !== "builtin" || settings.data?.experimental.enableBuiltInAgents || agents.some((agent) => isWorkspaceDirector(agent.metadata))).map((value) => ({
    value, label: `${t(value === "error" ? "agentProduct.attention" : value === "builtin" ? "agents.builtIn" : `agents.${value}`)} ${selectProductAgents(agents, value, "", builtInIds).length}`,
  }));

  useEffect(() => { setBreadcrumbs([{ label: t("agents.title") }]); }, [setBreadcrumbs, t]);
  useEffect(() => { setSearch(""); setConfigureState(null); }, [selectedCompanyId]);

  if (!selectedCompanyId) return <EmptyState icon={Bot} message={t("agentProduct.selectWorkspace")} />;

  return (
    <div className="space-y-5" data-testid="agent-roster">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("agents.title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={openNewAgent}><Plus className="size-4" />{t("agents.newAction")}</Button>
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <Tabs value={tab} onValueChange={(value) => navigate(`/agents/${value}`)}>
          <PageTabBar items={tabs} value={tab} onValueChange={(value) => navigate(`/agents/${value}`)} align="start" />
        </Tabs>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9 pr-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("agentProduct.search")} aria-label={t("agentProduct.search")} />
          {search && <button className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm hover:bg-accent" onClick={() => setSearch("")} aria-label={t("agentProduct.clearSearch")} title={t("agentProduct.clearSearch")}><X className="size-3.5" /></button>}
        </div>
      </div>
      {query.isLoading ? <PageSkeleton variant="list" /> : query.isError ? (
        <div className="flex items-center gap-3" role="alert"><p className="text-sm text-destructive">{t("agentProduct.loadFailed")}</p><Button variant="outline" onClick={() => void query.refetch()}><RefreshCw className="size-4" />{t("common.retry")}</Button></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Bot} message={agents.length === 0 ? t("agents.empty") : t("agentProduct.noMatches")} action={agents.length === 0 ? t("agents.newAction") : t("agentProduct.clearFilters")} onAction={agents.length === 0 ? openNewAgent : () => { setSearch(""); navigate("/agents/all"); }} />
      ) : (
        <div className="divide-y divide-border">
          <div className="hidden lg:flex items-center gap-5 px-3 pb-3 text-xs text-muted-foreground">
            <span className="flex-1">{t("agentProduct.agentAndPurpose")}</span><span className="w-48">{t("agentProduct.currentWork")}</span><span className="w-36">{t("agentProduct.runtime")}</span><span className="w-24">{t("agentProduct.status")}</span><span className="w-16" />
          </div>
          {filtered.map((agent) => {
            const director = isWorkspaceDirector(agent.metadata);
            const activeRun = live.data?.find((run) => run.agentId === agent.id && ["running", "queued"].includes(run.status));
            const builtIn = builtIns.data?.find((entry) => entry.agentId === agent.id);
            const model = typeof agent.adapterConfig.model === "string" ? agent.adapterConfig.model : null;
            return (
              <article key={agent.id} className="group flex flex-wrap items-center gap-4 px-3 py-4 transition-colors hover:bg-accent/40 lg:flex-nowrap lg:gap-5" data-testid="agent-roster-row">
                <Link to={agentUrl(agent)} className="flex min-w-0 flex-1 basis-full items-start gap-3 no-underline text-inherit sm:basis-0">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent"><AgentIcon icon={agent.icon} className="size-5" /></span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="break-words text-sm font-semibold">{agent.name}</span>{director && <span className="text-xs text-muted-foreground">{t("agentProduct.defaultAgent")}</span>}{agentNeedsAttention(agent) && <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-label={t("agentProduct.attention")} />}</div>
                    <p className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{director ? t("agentProduct.directorPurpose") : agent.capabilities || agent.title || t("agentProduct.specialistPurpose")}</p>
                  </div>
                </Link>
                <div className="hidden w-48 min-w-0 space-y-1 lg:block">
                  {activeRun ? <Link to={`/agents/${agentRouteRef(agent)}/runs/${activeRun.id}`} className="block truncate text-xs text-foreground">{activeRun.currentStatusMessage || t("agentProduct.executing")}</Link> : <span className="text-xs text-muted-foreground">{live.isError ? t("agentProduct.workUnavailable") : live.isPending ? t("common.loading") : director ? t("agentProduct.conversationWork") : t("agentProduct.noActiveRun")}</span>}
                  {!director && agent.lastHeartbeatAt && <span className="block text-xs text-muted-foreground">{relativeTime(agent.lastHeartbeatAt)}</span>}
                </div>
                <div className="hidden w-36 min-w-0 space-y-1 lg:block">
                  <span className="block truncate text-xs">{director ? t("directorBehavior.compatibility") : getAdapterLabel(agent.adapterType)}</span>
                  {!director && <span className="block truncate font-mono text-xs text-muted-foreground" title={model ?? undefined}>{model || t("agentProduct.runtimeDefault")}</span>}
                </div>
                <div className="w-24 shrink-0"><AgentStatusBadge status={agent.status} /></div>
                <div className="ml-auto flex w-16 shrink-0 items-center justify-end gap-1 lg:ml-0">
                  <StarToggle size="row" starred={isStarred(memberships.data, "agent", agent.id)} pending={membershipMutation.isPending && membershipMutation.variables?.resourceId === agent.id} resourceName={agent.name} onToggle={(starred) => membershipMutation.mutate({ resourceType: "agent", resourceId: agent.id, resourceName: agent.name, starred })} />
                  <Button asChild size="icon" variant="ghost" className="size-8" title={t(director ? "agentProduct.openChat" : "agentProduct.openAgent")} aria-label={t(director ? "agentProduct.openChat" : "agentProduct.openAgent")}><Link to={director ? "/chat" : agentUrl(agent)}>{director ? <MessageSquare className="size-4" /> : <ArrowUpRight className="size-4" />}</Link></Button>
                </div>
                {builtIn?.status === "needs_setup" && <Button variant="outline" size="sm" onClick={() => setConfigureState(builtIn)}>{t("agents.setUp")}</Button>}
              </article>
            );
          })}
        </div>
      )}
      {configureState && <Suspense fallback={null}><ConfigureBuiltInAgentModal companyId={selectedCompanyId} state={configureState} open onOpenChange={(open) => { if (!open) setConfigureState(null); }} /></Suspense>}
    </div>
  );
}
