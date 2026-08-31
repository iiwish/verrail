import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CircleAlert, PauseCircle, PlayCircle, Rocket } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { AgentStatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, relativeTime } from "../lib/utils";
import { useTranslation } from "@/i18n";

type DeploymentFilter = "all" | "active" | "paused" | "error";

function matchesFilter(agent: Agent, filter: DeploymentFilter) {
  if (filter === "all") return true;
  if (filter === "active") return ["active", "running", "idle"].includes(agent.status);
  return agent.status === filter;
}

export function AgentDeployments() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<DeploymentFilter>("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: t("nav.agents"), href: "/agents/definitions" },
      { label: t("agentNav.deployments") },
    ]);
  }, [setBreadcrumbs, t]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const runsQuery = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "agent-deployments"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 15_000,
  });

  const visibleAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => !["terminated", "pending_approval"].includes(agent.status)),
    [agentsQuery.data],
  );
  const filteredAgents = useMemo(
    () => visibleAgents.filter((agent) => matchesFilter(agent, filter)),
    [filter, visibleAgents],
  );
  const liveRunsByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runsQuery.data ?? []) {
      if (run.status !== "running" && run.status !== "queued") continue;
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [runsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Rocket} message={t("agents.selectCompany")} />;
  }
  if (agentsQuery.isLoading) return <PageSkeleton variant="list" />;
  if (agentsQuery.error) {
    return <EmptyState icon={CircleAlert} message={t("agentDeployments.unavailable")} />;
  }

  const tabItems = [
    { value: "all" as const, label: t("agents.all") },
    { value: "active" as const, label: t("agents.active") },
    { value: "paused" as const, label: t("agents.paused") },
    { value: "error" as const, label: t("agents.error") },
  ];

  return (
    <div className="space-y-4" data-testid="agent-deployments-page">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Rocket className="h-5 w-5 shrink-0 text-muted-foreground" />
          <h2 className="truncate text-xl font-semibold">{t("agentNav.deployments")}</h2>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("agentDeployments.total", { count: visibleAgents.length })}
        </span>
      </header>

      <Tabs value={filter} onValueChange={(value) => setFilter(value as DeploymentFilter)}>
        <PageTabBar items={tabItems} value={filter} onValueChange={(value) => setFilter(value as DeploymentFilter)} />
      </Tabs>

      {filteredAgents.length === 0 ? (
        <EmptyState icon={Bot} message={t("agentDeployments.empty")} />
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {filteredAgents.map((agent) => {
            const liveRuns = liveRunsByAgent.get(agent.id) ?? 0;
            return (
              <Link
                key={agent.id}
                to={agentUrl(agent)}
                className="flex min-w-0 items-center gap-3 px-1 py-3 transition-colors hover:bg-accent/30"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  {agent.status === "paused" ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{agent.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {getAdapterLabel(agent.adapterType)}
                    {agent.lastHeartbeatAt ? ` · ${relativeTime(agent.lastHeartbeatAt)}` : ""}
                  </span>
                </span>
                {liveRuns > 0 ? (
                  <span className="shrink-0 text-xs font-medium text-foreground">
                    {t("agentDeployments.liveRuns", { count: liveRuns })}
                  </span>
                ) : null}
                <AgentStatusBadge status={agent.status} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
