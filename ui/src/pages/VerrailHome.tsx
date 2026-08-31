import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, CircleAlert, Target } from "lucide-react";
import { Link } from "@/lib/router";
import { attentionApi } from "../api/attention";
import { heartbeatsApi } from "../api/heartbeats";
import { targetsApi } from "../api/targets";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { useTranslation } from "@/i18n";

function SectionState({ children }: { children: string }) {
  return <p className="py-8 text-sm text-muted-foreground">{children}</p>;
}

export function VerrailHome() {
  const { t } = useTranslation();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.home") }]);
  }, [setBreadcrumbs, t]);

  const attentionQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.attention(selectedCompanyId), "verrail-home"]
      : ["attention", "verrail-home", "disabled"],
    queryFn: () => attentionApi.list(selectedCompanyId!, { limit: 5 }),
    enabled: Boolean(selectedCompanyId),
  });
  const runsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.liveRuns(selectedCompanyId) : ["live-runs", "disabled"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const targetsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.targets.list(selectedCompanyId, null, { limit: 100 })
      : ["targets", "disabled"],
    queryFn: () => targetsApi.list(selectedCompanyId!, { limit: 100 }),
    enabled: Boolean(selectedCompanyId),
  });

  const attentionItems = attentionQuery.error ? [] : (attentionQuery.data?.items ?? []);
  const liveRuns = runsQuery.error ? [] : (runsQuery.data ?? []);
  const attentionCount = attentionQuery.data && !attentionQuery.error
    ? attentionQuery.data.totalCount
    : "--";
  const liveRunCount = runsQuery.data && !runsQuery.error ? liveRuns.length : "--";
  const targets = targetsQuery.error ? [] : (targetsQuery.data?.items ?? []);
  const targetCount = targetsQuery.data && !targetsQuery.error
    ? (targetsQuery.data.nextCursor ? `${targets.length}+` : targets.length)
    : "--";

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{selectedCompany?.name ?? t("nav.home")}</h2>
        </div>
        <Link to="/projects" className="inline-flex items-center gap-1 text-sm font-medium hover:underline">
          {t("nav.projects")}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      <dl className="grid grid-cols-1 border-y border-border sm:grid-cols-3">
        <div className="py-4 sm:pr-6">
          <dt className="text-xs font-medium text-muted-foreground">{t("verrailHome.attention")}</dt>
          <dd className="mt-1 text-2xl font-semibold">{attentionCount}</dd>
        </div>
        <div className="border-t border-border py-4 sm:border-l sm:border-t-0 sm:px-6">
          <dt className="text-xs font-medium text-muted-foreground">{t("verrailHome.liveRuns")}</dt>
          <dd className="mt-1 text-2xl font-semibold">{liveRunCount}</dd>
        </div>
        <div className="border-t border-border py-4 sm:border-l sm:border-t-0 sm:pl-6">
          <dt className="text-xs font-medium text-muted-foreground">{t("targets.title")}</dt>
          <dd className="mt-1 text-2xl font-semibold">{targetCount}</dd>
        </div>
      </dl>

      <section aria-labelledby="home-attention-title">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <h3 id="home-attention-title" className="text-sm font-semibold">{t("verrailHome.attention")}</h3>
          <Link to="/governance" className="text-xs text-muted-foreground hover:text-foreground">
            {t("verrailHome.viewAll")}
          </Link>
        </div>
        {attentionQuery.isLoading ? <SectionState>{t("verrailHome.loading")}</SectionState> : null}
        {attentionQuery.error ? <SectionState>{t("verrailHome.unavailable")}</SectionState> : null}
        {!attentionQuery.isLoading && !attentionQuery.error && attentionItems.length === 0 ? (
          <SectionState>{t("verrailHome.noAttention")}</SectionState>
        ) : null}
        {attentionItems.map((item) => {
          const content = (
            <>
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {item.subject.title ?? item.subject.identifier ?? item.sourceKind}
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">{item.whyNow}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(item.activityAt)}</span>
            </>
          );
          return item.subject.href ? (
            <Link key={item.id} to={item.subject.href} className="flex gap-3 border-b border-border py-3 hover:bg-accent/30">
              {content}
            </Link>
          ) : (
            <div key={item.id} className="flex gap-3 border-b border-border py-3">{content}</div>
          );
        })}
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section aria-labelledby="home-runs-title">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h3 id="home-runs-title" className="text-sm font-semibold">{t("verrailHome.liveRuns")}</h3>
            <Link to="/agents" className="text-xs text-muted-foreground hover:text-foreground">{t("verrailHome.viewAll")}</Link>
          </div>
          {runsQuery.isLoading ? <SectionState>{t("verrailHome.loading")}</SectionState> : null}
          {runsQuery.error ? <SectionState>{t("verrailHome.unavailable")}</SectionState> : null}
          {!runsQuery.isLoading && !runsQuery.error && liveRuns.length === 0 ? (
            <SectionState>{t("verrailHome.noRuns")}</SectionState>
          ) : null}
          {liveRuns.slice(0, 5).map((run) => (
            <Link key={run.id} to={`/agents/${run.agentId}/runs/${run.id}`} className="flex items-center gap-3 border-b border-border py-3 hover:bg-accent/30">
              <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.agentName}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{run.status}</span>
            </Link>
          ))}
        </section>

        <section aria-labelledby="home-targets-title">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h3 id="home-targets-title" className="text-sm font-semibold">{t("verrailHome.recentTargets")}</h3>
            <Link to="/projects" className="text-xs text-muted-foreground hover:text-foreground">{t("verrailHome.viewAll")}</Link>
          </div>
          {targetsQuery.isLoading ? <SectionState>{t("verrailHome.loading")}</SectionState> : null}
          {targetsQuery.error ? <SectionState>{t("verrailHome.unavailable")}</SectionState> : null}
          {!targetsQuery.isLoading && !targetsQuery.error && targets.length === 0 ? (
            <SectionState>{t("verrailHome.noTargets")}</SectionState>
          ) : null}
          {targets.slice(0, 5).map((target) => (
            <Link key={target.targetId} to={`/targets/${target.targetId}/overview`} className="flex items-center gap-3 border-b border-border py-3 hover:bg-accent/30">
              <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{target.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {target.currentStage?.label ?? t("targets.unknownStage")}
              </span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
