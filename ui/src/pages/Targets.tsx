import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TargetReadModelV1 } from "@paperclipai/shared";
import { AlertTriangle, FolderKanban, Network, Plus, Target } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { targetsApi } from "../api/targets";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useTranslation } from "../i18n";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { Link, useSearchParams } from "../lib/router";

type TargetView = "all" | "open" | "attention";

function isOpenTarget(target: TargetReadModelV1) {
  return target.status !== "accepted" && target.status !== "canceled";
}

export function Targets() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { openNewTarget } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  const collectionId = searchParams.get("collectionId") ?? undefined;
  const [view, setView] = useState<TargetView>("open");
  const targetsQuery = useQuery({
    queryKey: queryKeys.targets.list(selectedCompanyId ?? "__none__", collectionId, { limit: 100 }),
    queryFn: () => targetsApi.list(selectedCompanyId!, { limit: 100, collectionId }),
    enabled: Boolean(selectedCompanyId),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.targets") }]);
  }, [setBreadcrumbs, t]);

  const targets = targetsQuery.data?.items ?? [];
  const visibleTargets = useMemo(() => targets.filter((target) => {
    if (view === "attention") return target.attentionSummary.total > 0;
    if (view === "open") return isOpenTarget(target);
    return true;
  }), [targets, view]);
  const counts = {
    all: targetsQuery.data?.summary.total ?? targets.length,
    open: targetsQuery.data?.summary.open ?? targets.filter(isOpenTarget).length,
    attention: targetsQuery.data?.summary.attention
      ?? targets.filter((target) => target.attentionSummary.total > 0).length,
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message={t("targets.selectWorkspace")} />;
  }
  if (targetsQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{t("targets.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/collections">
              <FolderKanban className="h-4 w-4" />
              {t("collections.title")}
            </Link>
          </Button>
          <Button size="sm" onClick={() => openNewTarget()}>
            <Plus className="h-4 w-4" />
            {t("targets.create.submit")}
          </Button>
        </div>
      </div>

      <Tabs value={view} onValueChange={(value) => setView(value as TargetView)}>
        <TabsList aria-label={t("targets.list.filterLabel")}>
          {(["open", "attention", "all"] as const).map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`targets.list.${value}`)}
              <span className="text-xs text-muted-foreground tabular-nums">{counts[value]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {targetsQuery.error ? <p className="text-sm text-destructive">{t("targets.loadFailed")}</p> : null}

      {!targetsQuery.error && visibleTargets.length === 0 ? (
        <EmptyState
          icon={Target}
          message={targets.length === 0 ? t("targets.emptyDetail") : t("targets.list.noMatches")}
        />
      ) : null}

      {visibleTargets.length > 0 ? (
        <div className="border-y border-border" data-testid="workspace-target-list">
          {visibleTargets.map((target) => (
            <EntityRow
              key={target.targetId}
              to={`/targets/${target.targetId}/overview`}
              leading={<Target className="h-4 w-4 text-muted-foreground" />}
              title={target.title}
              subtitle={target.summary ?? target.definition?.goal ?? undefined}
              reserveSubtitleSpace
              titlePriority
              meta={
                <div className="hidden min-w-0 items-center gap-3 lg:flex">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Network className="h-3.5 w-3.5" />
                    {target.currentStage?.label ?? t("targets.unknownStage")}
                  </span>
                  {target.collection ? (
                    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <FolderKanban className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{target.collection.name}</span>
                    </span>
                  ) : null}
                </div>
              }
              trailing={
                <div className="flex items-center gap-3">
                  {target.attentionSummary.total > 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {target.attentionSummary.total}
                    </span>
                  ) : null}
                  <StatusBadge status={target.status} label={t(`targets.statuses.${target.status}`)} />
                  <span className="hidden text-xs text-muted-foreground xl:inline">{formatDateTime(target.updatedAt)}</span>
                </div>
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
