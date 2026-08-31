import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { targetsApi } from "../api/targets";
import { ApiError } from "../api/client";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { useTranslation } from "@/i18n";

const TARGET_TABS = [
  "overview",
  "stages",
  "work",
  "submission",
  "artifacts",
  "evidence",
  "runs",
  "timeline",
] as const;
type TargetTab = (typeof TARGET_TABS)[number];

function isTargetTab(value: string | undefined): value is TargetTab {
  return TARGET_TABS.includes(value as TargetTab);
}

function EmptyTab({ message }: { message: string }) {
  return <p className="border-y border-border py-10 text-sm text-muted-foreground">{message}</p>;
}

export function TargetWorkbench() {
  const { targetId, targetRevisionId, tab } = useParams<{
    targetId: string;
    targetRevisionId?: string;
    tab?: string;
  }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const activeTab: TargetTab = isTargetTab(tab) ? tab : "overview";
  const isRevision = Boolean(targetRevisionId);

  const query = useQuery({
    queryKey: selectedCompanyId && targetId
      ? targetRevisionId
        ? queryKeys.targets.revision(selectedCompanyId, targetId, targetRevisionId)
        : queryKeys.targets.detail(selectedCompanyId, targetId)
      : ["targets", "disabled"],
    queryFn: () => targetRevisionId
      ? targetsApi.getRevision(selectedCompanyId!, targetId!, targetRevisionId)
      : targetsApi.get(selectedCompanyId!, targetId!),
    enabled: Boolean(selectedCompanyId && targetId),
  });

  useEffect(() => {
    const breadcrumbs: Array<{ label: string; href?: string }> = [
      { label: t("nav.projects"), href: "/projects" },
    ];
    if (query.data?.project) {
      breadcrumbs.push({
        label: query.data.project.name,
        href: `/projects/${query.data.project.id}/overview`,
      });
    }
    breadcrumbs.push({ label: query.data?.title ?? t("targets.target") });
    if (isRevision) breadcrumbs.push({ label: t("targets.revision") });
    setBreadcrumbs(breadcrumbs);
  }, [isRevision, query.data?.project, query.data?.title, setBreadcrumbs, t]);

  if (query.isLoading) return <PageSkeleton variant="detail" />;
  if (query.error) {
    const message = query.error instanceof ApiError && query.error.status === 503
      ? t("targets.projectionUnavailable")
      : query.error instanceof ApiError && query.error.status === 404
        ? t("targets.notFound")
        : t("targets.loadFailed");
    return <p className="py-8 text-sm text-destructive">{message}</p>;
  }
  const target = query.data;
  if (!target) return null;

  const warnings = target.compatibility?.warnings ?? [];
  const warningMessages = [
    ...(warnings.includes("projection_stale") ? [t("targets.projectionStale")] : []),
    ...(warnings.includes("projection_schema_upgraded") ? [t("targets.projectionSchemaUpgraded")] : []),
    ...(warnings.includes("source_missing") ? [t("targets.sourceMissing")] : []),
    ...(target.compatibility?.completionUnverified ? [t("targets.completionUnverified")] : []),
  ];
  const tabItems = TARGET_TABS.map((value) => ({ value, label: t(`targets.tabs.${value}`) }));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {isRevision ? (
        <Link to={`/targets/${target.targetId}/overview`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t("targets.backToActive")}
        </Link>
      ) : null}

      <header className="space-y-3 border-b border-border pb-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t(`targets.statuses.${target.status}`)}</span>
          <span>·</span>
          <span>{target.currentStage?.label ?? t("targets.unknownStage")}</span>
          <span>·</span>
          <span>
            {isRevision
              ? t("targets.immutableRevision")
              : target.authority.kind === "native"
                ? t("targets.nativeRevision")
                : t("targets.compatibilityProjection")}
          </span>
        </div>
        <h2 className="text-xl font-semibold">{target.title}</h2>
        {target.summary ? <p className="max-w-3xl text-sm text-muted-foreground">{target.summary}</p> : null}
      </header>

      {warningMessages.length > 0 ? (
        <div className="flex items-start gap-3 border-y border-border py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            {warningMessages.map((message) => <p key={message}>{message}</p>)}
          </div>
        </div>
      ) : null}

      {!isRevision ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => navigate(`/targets/${target.targetId}/${value}`)}
        >
          <PageTabBar
            items={tabItems}
            value={activeTab}
            onValueChange={(value) => navigate(`/targets/${target.targetId}/${value}`)}
            align="start"
          />
        </Tabs>
      ) : null}

      {(isRevision || activeTab === "overview") ? (
        <div className="space-y-7">
          <dl className="grid grid-cols-1 border-y border-border sm:grid-cols-2 lg:grid-cols-4">
            <div className="py-4 sm:pr-5">
              <dt className="text-xs text-muted-foreground">{t("targets.project")}</dt>
              <dd className="mt-1 text-sm font-medium">{target.project?.name ?? t("targets.noProject")}</dd>
            </div>
            <div className="border-t border-border py-4 sm:border-l sm:border-t-0 sm:px-5">
              <dt className="text-xs text-muted-foreground">{t("targets.outcomeOwner")}</dt>
              <dd className="mt-1 text-sm font-medium">
                {target.outcomeOwner?.displayName ?? target.outcomeOwner?.principalId ?? t("targets.unassigned")}
              </dd>
            </div>
            <div className="border-t border-border py-4 sm:pr-5 lg:border-l lg:border-t-0 lg:px-5">
              <dt className="text-xs text-muted-foreground">{t("targets.risk")}</dt>
              <dd className="mt-1 text-sm font-medium">{t(`targets.risks.${target.risk.level}`)}</dd>
            </div>
            <div className="border-t border-border py-4 sm:border-l sm:px-5 lg:border-t-0">
              <dt className="text-xs text-muted-foreground">{t("targets.updated")}</dt>
              <dd className="mt-1 text-sm font-medium">{formatDateTime(target.updatedAt)}</dd>
            </div>
          </dl>

          {target.definition ? (
            <section aria-labelledby="target-definition-title" className="space-y-5 border-y border-border py-5">
              <div>
                <h3 id="target-definition-title" className="text-sm font-semibold">{t("targets.goal")}</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{target.definition.goal}</p>
              </div>
              {target.definition.constraints.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold">{t("targets.constraints")}</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {target.definition.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}
                  </ul>
                </div>
              ) : null}
              <div>
                <h3 className="text-sm font-semibold">{t("targets.acceptanceCriteria")}</h3>
                <ol className="mt-2 space-y-3">
                  {target.definition.acceptanceCriteria.map((criterion, index) => (
                    <li key={criterion.id} className="border-l border-border pl-3 text-sm">
                      <p className="font-medium">{index + 1}. {criterion.title}</p>
                      {criterion.description ? <p className="mt-1 text-muted-foreground">{criterion.description}</p> : null}
                    </li>
                  ))}
                </ol>
              </div>
              {(target.definition.deadline || target.definition.policySummary) ? (
                <dl className="grid gap-4 sm:grid-cols-2">
                  {target.definition.deadline ? (
                    <div><dt className="text-xs text-muted-foreground">{t("targets.deadline")}</dt><dd className="mt-1 text-sm font-medium">{target.definition.deadline}</dd></div>
                  ) : null}
                  {target.definition.policySummary ? (
                    <div><dt className="text-xs text-muted-foreground">{t("targets.policy")}</dt><dd className="mt-1 text-sm font-medium">{target.definition.policySummary}</dd></div>
                  ) : null}
                </dl>
              ) : null}
            </section>
          ) : null}

          <section aria-labelledby="target-proof-title">
            <h3 id="target-proof-title" className="mb-3 text-sm font-semibold">{t("targets.proof")}</h3>
            <div className="grid grid-cols-2 border-y border-border sm:grid-cols-4">
              <div className="py-4"><p className="text-2xl font-semibold">{target.artifactSummary.count}</p><p className="text-xs text-muted-foreground">{t("targets.tabs.artifacts")}</p></div>
              <div className="border-l border-border p-4"><p className="text-2xl font-semibold">{target.evidenceSummary.count}</p><p className="text-xs text-muted-foreground">{t("targets.tabs.evidence")}</p></div>
              <div className="border-t border-border py-4 sm:border-l sm:border-t-0 sm:p-4"><p className="text-2xl font-semibold">{target.runSummary.active}</p><p className="text-xs text-muted-foreground">{t("targets.activeRuns")}</p></div>
              <div className="border-l border-t border-border p-4 sm:border-t-0"><p className="text-2xl font-semibold">{target.attentionSummary.total}</p><p className="text-xs text-muted-foreground">{t("targets.attention")}</p></div>
            </div>
          </section>

          {target.authority.kind === "compatibility" ? (
          <section aria-labelledby="target-source-title" className="border-y border-border py-4">
            <h3 id="target-source-title" className="text-sm font-semibold">{t("targets.source")}</h3>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{target.source.identifier ?? target.source.id}</span>
              {warnings.includes("source_missing") ? (
                <span className="text-muted-foreground">{t("targets.sourceUnavailable")}</span>
              ) : (
                <Link to={target.source.href} className="inline-flex items-center gap-1 font-medium hover:underline">
                  {t("targets.openSource")}
                  <ExternalLink className="h-4 w-4" />
                </Link>
              )}
            </div>
          </section>
          ) : null}

          <div className="flex items-start gap-3 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <p>{t("targets.readOnlyNotice")}</p>
          </div>
        </div>
      ) : null}

      {activeTab === "stages" && !isRevision ? <EmptyTab message={t("targets.emptyTabs.stages")} /> : null}
      {activeTab === "work" && !isRevision ? <EmptyTab message={t("targets.emptyTabs.work")} /> : null}
      {activeTab === "submission" && !isRevision ? <EmptyTab message={t("targets.emptyTabs.submission")} /> : null}
      {activeTab === "artifacts" && !isRevision ? <EmptyTab message={t("targets.emptyTabs.artifacts")} /> : null}
      {activeTab === "evidence" && !isRevision ? <EmptyTab message={t("targets.emptyTabs.evidence")} /> : null}
      {activeTab === "runs" && !isRevision ? <EmptyTab message={t("targets.emptyTabs.runs")} /> : null}
      {activeTab === "timeline" && !isRevision ? <EmptyTab message={t("targets.emptyTabs.timeline")} /> : null}
    </div>
  );
}
