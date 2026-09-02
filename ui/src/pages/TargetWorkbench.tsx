import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Circle,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { targetsApi } from "../api/targets";
import { ApiError } from "../api/client";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { useTranslation } from "@/i18n";

const TARGET_TABS = [
  "overview",
  "work",
  "runs",
  "artifacts",
  "evidence",
  "acceptance",
  "stages",
  "submission",
  "timeline",
] as const;
type TargetTab = (typeof TARGET_TABS)[number];

function isTargetTab(value: string | undefined): value is TargetTab {
  return TARGET_TABS.includes(value as TargetTab);
}

function EmptyTab({ message }: { message: string }) {
  return <p className="border-y border-border py-10 text-sm text-muted-foreground">{message}</p>;
}

function commandFailureDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: string } | null)?.code;
  return code ?? String(error.status);
}

function WorkspaceSectionState({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: boolean;
  empty: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (loading) return <p className="border-y border-border py-10 text-sm text-muted-foreground">{t("targets.workspaceLoading")}</p>;
  if (error) return <p className="border-y border-border py-10 text-sm text-destructive">{t("targets.workspaceLoadFailed")}</p>;
  return <>{children || <EmptyTab message={empty} />}</>;
}

export function TargetWorkbench() {
  const { targetId, targetRevisionId, tab } = useParams<{
    targetId: string;
    targetRevisionId?: string;
    tab?: string;
  }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  const workspaceQuery = useQuery({
    queryKey: selectedCompanyId && targetId
      ? queryKeys.targets.workspace(selectedCompanyId, targetId)
      : ["targets", "workspace", "disabled"],
    queryFn: () => targetsApi.getWorkspace(selectedCompanyId!, targetId!),
    enabled: Boolean(selectedCompanyId && targetId && !isRevision),
  });

  const createConversation = useMutation({
    mutationFn: () => targetsApi.createConversation(selectedCompanyId!, targetId!),
    onSuccess: (conversation) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(selectedCompanyId!) });
      navigate(`/chat/${conversation.id}`);
    },
  });

  const refreshWorkspace = async () => {
    if (!selectedCompanyId || !targetId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.targets.workspace(selectedCompanyId, targetId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.targets.detail(selectedCompanyId, targetId) }),
    ]);
  };

  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  const retryRun = useMutation({
    mutationFn: (runId: string) => targetsApi.createRunAttempt(selectedCompanyId!, runId, {
      runtimeProfile: "host_trusted",
      executor: { principalType: "service", principalId: "host-trusted-local" },
    }, crypto.randomUUID()),
    onMutate: (runId) => setPendingRunId(runId),
    onSettled: () => setPendingRunId(null),
    onSuccess: refreshWorkspace,
  });

  const cancelRun = useMutation({
    mutationFn: (runId: string) => targetsApi.requestRunCancellation(selectedCompanyId!, runId, crypto.randomUUID()),
    onMutate: (runId) => setPendingRunId(runId),
    onSettled: () => setPendingRunId(null),
    onSuccess: refreshWorkspace,
  });

  useEffect(() => {
    const breadcrumbs: Array<{ label: string; href?: string }> = [
      { label: t("nav.targets"), href: "/targets" },
    ];
    breadcrumbs.push({ label: query.data?.title ?? t("targets.target") });
    if (isRevision) breadcrumbs.push({ label: t("targets.revision") });
    setBreadcrumbs(breadcrumbs);
  }, [isRevision, query.data?.title, setBreadcrumbs, t]);

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
  const workspace = workspaceQuery.data;
  const runCommandError = retryRun.error ?? cancelRun.error;
  const runCommandFailureDetail = commandFailureDetail(runCommandError);

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
              : t("targets.nativeRevision")}
          </span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-xl font-semibold">{target.title}</h2>
          {!isRevision ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => createConversation.mutate()}
              disabled={createConversation.isPending}
            >
              <MessageSquare className="h-4 w-4" />
              {createConversation.isPending ? t("targets.conversationCreating") : t("targets.discuss")}
            </Button>
          ) : null}
        </div>
        {createConversation.isError ? (
          <p className="text-sm text-destructive">{t("targets.conversationFailed")}</p>
        ) : null}
        {target.summary ? <p className="max-w-3xl text-sm text-muted-foreground">{target.summary}</p> : null}
      </header>

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
              <dt className="text-xs text-muted-foreground">{t("targets.collection")}</dt>
              <dd className="mt-1 text-sm font-medium">
                {target.collection ? (
                  <Link to="/collections" className="hover:underline">
                    {target.collection.name}
                  </Link>
                ) : t("targets.noCollection")}
              </dd>
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

          <div className="flex items-start gap-3 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <p>{t("targets.readOnlyNotice")}</p>
          </div>
        </div>
      ) : null}

      {activeTab === "stages" && !isRevision ? (
        <WorkspaceSectionState
          loading={workspaceQuery.isLoading}
          error={workspaceQuery.isError}
          empty={t("targets.emptyTabs.stages")}
        >
          {workspace?.stages.length ? (
            <ol className="border-y border-border">
              {workspace.stages.map((stage) => (
                <li key={stage.key} className="flex items-center gap-3 border-b border-border py-4 last:border-b-0">
                  {stage.state === "completed" ? (
                    <Check className="h-4 w-4 text-success" />
                  ) : (
                    <Circle className={stage.state === "blocked" ? "h-4 w-4 text-destructive" : "h-4 w-4 text-muted-foreground"} />
                  )}
                  <span className="text-sm font-medium">{t(`targets.stageNames.${stage.key}`)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{t(`targets.stageStates.${stage.state}`)}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "work" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.work")}>
          {workspace?.work.length ? (
            <ul className="border-y border-border">
              {workspace.work.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-3 border-b border-border py-4 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.nodeKey} · {item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{item.kind} · {item.stage}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{item.status}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "submission" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.submission")}>
          {workspace?.submissions.length ? (
            <ul className="border-y border-border">
              {workspace.submissions.map((submission) => (
                <li key={submission.id} className="flex items-center justify-between py-4 text-sm">
                  <span className="font-medium">{submission.id}</span>
                  <span className="text-muted-foreground">{submission.status}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "artifacts" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.artifacts")}>
          {workspace?.artifacts.length ? (
            <ul className="border-y border-border">
              {workspace.artifacts.map((artifact) => (
                <li key={artifact.id} className="flex items-center justify-between gap-3 border-b border-border py-4 last:border-b-0">
                  <Link to={artifact.href} className="truncate text-sm font-medium hover:underline">{artifact.title}</Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{artifact.mediaKind}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "evidence" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.evidence")}>
          {workspace?.evidence.length ? (
            <ul className="border-y border-border">
              {workspace.evidence.map((evidence) => (
                <li key={evidence.id} className="flex items-center justify-between gap-3 border-b border-border py-4 text-sm last:border-b-0">
                  <span className="font-medium">{evidence.title}</span>
                  <span className="text-muted-foreground">{evidence.result}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "acceptance" && !isRevision ? (
        <EmptyTab message={t("targets.emptyTabs.acceptance")} />
      ) : null}

      {activeTab === "runs" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.runs")}>
          {workspace?.runs.length ? (
            <ul className="border-y border-border">
              {workspace.runs.map((run) => (
                <li key={run.id} className="space-y-4 border-b border-border py-4 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{run.actor.principalId}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {run.kind} · {t("targets.execution.runId", { id: run.id.slice(0, 8) })} · {t("targets.execution.attemptCount", { count: run.attempt })}
                      </p>
                    </div>
                    <span className="text-xs font-medium">{t(`targets.execution.statuses.${run.status}`)}</span>
                    {(run.status === "failed" || (run.status === "queued" && run.attempt === 0)) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => retryRun.mutate(run.id)}
                        disabled={pendingRunId === run.id}
                      >
                        <RefreshCw className="h-4 w-4" />
                        {t(run.attempt === 0 ? "targets.execution.start" : "targets.execution.retry")}
                      </Button>
                    ) : null}
                    {(run.status === "queued" || run.status === "running") && run.attempt > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => cancelRun.mutate(run.id)}
                        disabled={pendingRunId === run.id}
                      >
                        <Square className="h-4 w-4" />
                        {t("targets.execution.cancel")}
                      </Button>
                    ) : null}
                  </div>
                  {run.attempts.length ? (
                    <ol className="divide-y divide-border border-t border-border">
                      {run.attempts.map((attempt) => (
                        <li key={attempt.id} className="grid gap-2 py-3 text-xs sm:grid-cols-4">
                          <span className="font-medium">{t("targets.execution.attempt", { number: attempt.attemptNumber })}</span>
                          <span className="text-muted-foreground">{t("targets.execution.fence", { token: attempt.fencingToken })}</span>
                          <span className="text-muted-foreground">{t("targets.execution.cursor", { cursor: attempt.lastEventCursor })}</span>
                          <span className="text-muted-foreground">
                            {attempt.lease
                              ? t("targets.execution.lease", { status: t(`targets.execution.leaseStatuses.${attempt.lease.status}`) })
                              : t("targets.execution.noLease")}
                          </span>
                          {attempt.errorMessage ? <span className="text-destructive sm:col-span-4">{attempt.errorMessage}</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {runCommandError ? (
            <p className="mt-3 text-sm text-destructive">
              {runCommandFailureDetail
                ? t("targets.execution.commandFailedDetail", { detail: runCommandFailureDetail })
                : t("targets.execution.commandFailed")}
            </p>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "timeline" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.timeline")}>
          {workspace?.timeline.length ? (
            <ol className="border-y border-border">
              {workspace.timeline.map((event) => (
                <li key={event.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-4 last:border-b-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t(`targets.timelineEvents.${event.type}`)}</p>
                    {event.detail ? <p className="mt-1 truncate text-xs text-muted-foreground">{event.detail}</p> : null}
                  </div>
                  <time className="text-xs text-muted-foreground">{formatDateTime(event.occurredAt)}</time>
                </li>
              ))}
            </ol>
          ) : null}
        </WorkspaceSectionState>
      ) : null}
    </div>
  );
}
