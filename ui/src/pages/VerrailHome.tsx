import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, CircleAlert, FolderKanban } from "lucide-react";
import { Link } from "@/lib/router";
import { attentionApi } from "../api/attention";
import { heartbeatsApi } from "../api/heartbeats";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { projectUrl, relativeTime } from "../lib/utils";
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
  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "disabled"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const attentionItems = attentionQuery.error ? [] : (attentionQuery.data?.items ?? []);
  const liveRuns = runsQuery.error ? [] : (runsQuery.data ?? []);
  const projects = projectsQuery.error ? [] : (projectsQuery.data ?? []);
  const attentionCount = attentionQuery.data && !attentionQuery.error
    ? attentionQuery.data.totalCount
    : "--";
  const liveRunCount = runsQuery.data && !runsQuery.error ? liveRuns.length : "--";
  const projectCount = projectsQuery.data && !projectsQuery.error ? projects.length : "--";

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
          <dt className="text-xs font-medium text-muted-foreground">{t("nav.projects")}</dt>
          <dd className="mt-1 text-2xl font-semibold">{projectCount}</dd>
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

        <section aria-labelledby="home-projects-title">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h3 id="home-projects-title" className="text-sm font-semibold">{t("nav.projects")}</h3>
            <Link to="/projects" className="text-xs text-muted-foreground hover:text-foreground">{t("verrailHome.viewAll")}</Link>
          </div>
          {projectsQuery.isLoading ? <SectionState>{t("verrailHome.loading")}</SectionState> : null}
          {projectsQuery.error ? <SectionState>{t("verrailHome.unavailable")}</SectionState> : null}
          {!projectsQuery.isLoading && !projectsQuery.error && projects.length === 0 ? (
            <SectionState>{t("verrailHome.noProjects")}</SectionState>
          ) : null}
          {projects.slice(0, 5).map((project) => (
            <Link key={project.id} to={projectUrl(project)} className="flex items-center gap-3 border-b border-border py-3 hover:bg-accent/30">
              <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("verrailHome.taskCount", { count: project.taskCount ?? 0 })}
              </span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
