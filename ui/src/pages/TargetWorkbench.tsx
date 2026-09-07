import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Circle,
  Download,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  UserCheck,
} from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { targetsApi } from "../api/targets";
import { agentLifecycleApi } from "../api/agentLifecycle";
import { ApiError } from "../api/client";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { queryKeys } from "../lib/queryKeys";
import { useAccountIdentity } from "../api/companies-query";
import { formatDateTime } from "../lib/utils";
import { cn } from "@/lib/utils";
import type {
  AdjudicationAcceptanceV1,
  AdjudicationDeliveryReviewV1,
  AdjudicationReviewVerdict,
  AdjudicationAcceptanceValidity,
  ConnectorActionRequestV1,
  AssuranceClaimStatus,
  AssuranceEvidenceV1,
  AssuranceVerdict,
  TargetAvailableCommandV1,
} from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { CriterionProofEditor } from "@/components/targets/CriterionProofEditor";

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

type WorkbenchCommandRequest =
  | { id: "create_graph_revision"; deploymentRevisionId: string; completionDefinition: string }
  | { id: "activate_graph_revision"; graphRevisionId: string }
  | { id: "create_run"; graphRevisionId: string; workNodeId: string; deploymentRevisionId: string }
  | { id: "record_review"; submissionId: string; verdict: AdjudicationReviewVerdict; comments: string }
  | { id: "accept_submission"; submissionId: string; reviewId: string }
  | { id: "approve_action"; action: ConnectorActionRequestV1 }
  | { id: "execute_action"; actionRequestId: string };

type WorkbenchCommandEnvelope = {
  request: WorkbenchCommandRequest;
  idempotencyKey: string;
};

function isTargetTab(value: string | undefined): value is TargetTab {
  return TARGET_TABS.includes(value as TargetTab);
}

function EmptyTab({ message }: { message: string }) {
  return <p className="border-y border-border py-10 text-sm text-muted-foreground">{message}</p>;
}

const TONE_BADGE_CLASSES = {
  neutral: statusBadgeDefault,
  positive: statusBadge.succeeded,
  danger: statusBadge.failed,
  warning: statusBadge.warning,
} as const;

type ToneLevel = keyof typeof TONE_BADGE_CLASSES;

function ToneBadge({ tone, children }: { tone: ToneLevel; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONE_BADGE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

const VERDICT_TONES: Record<AssuranceVerdict, ToneLevel> = {
  passed: "positive",
  failed: "danger",
  inconclusive: "neutral",
  waived: "warning",
};

const CLAIM_STATUS_TONES: Record<AssuranceClaimStatus, ToneLevel> = {
  open: "neutral",
  supported: "positive",
  refuted: "danger",
  waived: "warning",
};

const REVIEW_VERDICT_TONES: Record<AdjudicationReviewVerdict, ToneLevel> = {
  approved: "positive",
  changes_requested: "warning",
  rejected: "danger",
};

const ACCEPTANCE_VALIDITY_TONES: Record<AdjudicationAcceptanceValidity, ToneLevel> = {
  valid: "positive",
  invalid: "warning",
};

function acceptanceValidityLabelKey(acceptance: Pick<AdjudicationAcceptanceV1, "validity" | "invalidReason">): string {
  return acceptance.validity === "valid" || acceptance.invalidReason === null
    ? "targets.adjudication.accepted"
    : `targets.adjudication.invalidReasons.${acceptance.invalidReason}`;
}

function truncateFact(value: string) {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function commandFailureDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: string } | null)?.code;
  return code ?? String(error.status);
}

const COMMAND_STATE_TONES: Record<TargetAvailableCommandV1["state"], ToneLevel> = {
  available: "positive",
  blocked: "warning",
  completed: "neutral",
};

function CommandBinding({ value, label }: { value: string; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <span className="truncate font-mono" title={value}>{truncateFact(value)}</span>
    </span>
  );
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

function EvidenceList({ items }: { items: AssuranceEvidenceV1[] }) {
  const { t } = useTranslation();
  return (
    <ol className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-muted-foreground">
          <ToneBadge tone="neutral">{t(`targets.assurance.evidenceKinds.${item.kind}`)}</ToneBadge>
          <ToneBadge tone="neutral">{t(`targets.assurance.trustLevels.${item.trustLevel}`)}</ToneBadge>
          <span>{item.producer.principalId}</span>
          <span className="min-w-0 truncate font-mono" title={item.reference}>{truncateFact(item.reference)}</span>
          <span className="font-mono" title={item.objectHash}>{truncateFact(item.objectHash)}</span>
        </li>
      ))}
    </ol>
  );
}

function DeliveryReviewList({ reviews }: { reviews: AdjudicationDeliveryReviewV1[] }) {
  const { t } = useTranslation();
  return (
    <ol className="divide-y divide-border border-t border-border">
      {reviews.map((review) => (
        <li key={review.id} className="space-y-2 py-2 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ToneBadge tone={REVIEW_VERDICT_TONES[review.verdict]}>
              {t(`targets.adjudication.reviewVerdicts.${review.verdict}`)}
            </ToneBadge>
            <span>{review.reviewer.principalId}</span>
            <span>{formatDateTime(review.createdAt)}</span>
          </div>
          {review.unprovenItems.length ? (
            <div className="space-y-1">
              <p className="font-medium">{t("targets.adjudication.unprovenItems")}</p>
              <ul className="list-disc space-y-1 pl-5">
                {review.unprovenItems.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          ) : null}
          {review.risks ? <p>{t("targets.adjudication.risks", { risks: review.risks })}</p> : null}
          {review.comments ? <p>{t("targets.adjudication.comments", { comments: review.comments })}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function AcceptanceChip({ acceptance }: { acceptance: AdjudicationAcceptanceV1 }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToneBadge tone={ACCEPTANCE_VALIDITY_TONES[acceptance.validity]}>
        {t(acceptanceValidityLabelKey(acceptance))}
      </ToneBadge>
      <span className="text-xs text-muted-foreground">
        {t(`targets.adjudication.authorities.${acceptance.authority}`)}
      </span>
      <span className="text-xs text-muted-foreground">{acceptance.acceptedBy.principalId}</span>
    </div>
  );
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
  const { userId: accountUserId, settled: accountIdentitySettled } = useAccountIdentity();
  const activeTab: TargetTab = isTargetTab(tab) ? tab : "overview";
  const isRevision = Boolean(targetRevisionId);
  const [graphDeploymentRevisionId, setGraphDeploymentRevisionId] = useState("");
  const [graphCompletionDefinition, setGraphCompletionDefinition] = useState<string | null>(null);
  const deliveryCompletion = graphCompletionDefinition ?? t("targets.commands.defaultNodes.deliverCompletion");
  const [reviewVerdict, setReviewVerdict] = useState<AdjudicationReviewVerdict>("approved");
  const [reviewComments, setReviewComments] = useState("");
  const [lastCommand, setLastCommand] = useState<WorkbenchCommandEnvelope | null>(null);
  const [successfulCommand, setSuccessfulCommand] = useState<WorkbenchCommandRequest["id"] | null>(null);

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
    refetchInterval: activeTab === "runs" && !isRevision ? 5_000 : false,
  });

  const agentLifecycleQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agentLifecycle(selectedCompanyId) : ["agent-lifecycle", "disabled"],
    queryFn: () => agentLifecycleApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && !isRevision),
  });

  const deploymentRevisionOptions = (agentLifecycleQuery.data?.definitions ?? []).flatMap((definition) =>
    definition.deployments.flatMap((deployment) => {
      const revision = deployment.status === "active" && deployment.activeRevision?.state === "active"
        ? deployment.activeRevision
        : null;
      return revision ? [{
        id: revision.id,
        label: `${definition.name} / ${deployment.name} r${revision.revisionNumber}`,
        isDefault: deployment.id === agentLifecycleQuery.data?.defaultDeploymentId,
      }] : [];
    }),
  );
  const selectedDeploymentRevisionId = deploymentRevisionOptions.some((option) => option.id === graphDeploymentRevisionId)
    ? graphDeploymentRevisionId
    : deploymentRevisionOptions.find((option) => option.isDefault)?.id ?? deploymentRevisionOptions[0]?.id ?? "";

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

  const commandMutation = useMutation({
    mutationFn: async ({ request, idempotencyKey }: WorkbenchCommandEnvelope) => {
      const workspaceId = selectedCompanyId!;
      const actorId = accountUserId ?? "board";
      switch (request.id) {
        case "create_graph_revision": {
          const criteria = query.data!.definition.acceptanceCriteria;
          const typed = criteria.some((criterion) => criterion.proofContract);
          const verificationNodes = typed ? criteria.flatMap((criterion, index) => {
            const requirements = criterion.proofContract?.allOf ?? [{ id: "legacy", kind: "independent_verification" as const, phase: "pre_acceptance" as const, assertions: [criterion.description ?? criterion.title] }];
            return requirements.filter((requirement) => requirement.kind === "independent_verification").map((requirement) => ({
              nodeKey: `verify-${index}-${requirement.id}`,
              kind: "integration_task" as const,
              stage: requirement.phase === "pre_acceptance" ? "verify" as const : "accept" as const,
              title: criterion.title,
              dependencyNodeKeys: [requirement.phase === "pre_acceptance" ? "deliver" : "accept"],
              completionDefinition: JSON.stringify({ criterionKey: criterion.id, requirementId: requirement.id, assertions: requirement.kind === "independent_verification" ? requirement.assertions : [] }),
            }));
          }) : [{ nodeKey: "verify", kind: "integration_task" as const, stage: "verify" as const, title: t("targets.commands.defaultNodes.verify"), dependencyNodeKeys: ["deliver"], completionDefinition: t("targets.commands.defaultNodes.verifyCompletion") }];
          const preNodes = verificationNodes.filter((node) => node.stage === "verify");
          return targetsApi.createGraphRevision(workspaceId, targetId!, {
            expectedTargetRevisionId: query.data!.activeTargetRevisionId,
            nodes: [
              {
                nodeKey: "deliver",
                kind: "agent_task",
                stage: "execute",
                title: t("targets.commands.defaultNodes.deliver"),
                responsiblePrincipal: { principalType: "agent", principalId: request.deploymentRevisionId },
                dependencyNodeKeys: [],
                completionDefinition: request.completionDefinition,
              },
              ...preNodes,
              {
                nodeKey: "review",
                kind: "review_gate",
                stage: "accept",
                title: t("targets.commands.defaultNodes.review"),
                dependencyNodeKeys: preNodes.length ? preNodes.map((node) => node.nodeKey) : ["deliver"],
                completionDefinition: t("targets.commands.defaultNodes.reviewCompletion"),
              },
              {
                nodeKey: "accept",
                kind: "acceptance_gate",
                stage: "accept",
                title: t("targets.commands.defaultNodes.accept"),
                dependencyNodeKeys: ["review"],
                completionDefinition: t("targets.commands.defaultNodes.acceptCompletion"),
              },
              ...verificationNodes.filter((node) => node.stage === "accept"),
            ],
          }, idempotencyKey);
        }
        case "activate_graph_revision":
          return targetsApi.activateGraphRevision(workspaceId, targetId!, request.graphRevisionId, idempotencyKey);
        case "create_run":
          return targetsApi.createRun(workspaceId, targetId!, request.graphRevisionId, request.workNodeId, {
            kind: "agent_run",
            actor: { principalType: "agent", principalId: request.deploymentRevisionId },
          }, idempotencyKey);
        case "record_review":
          return targetsApi.recordDeliveryReview(workspaceId, {
            submissionId: request.submissionId,
            reviewerPrincipalType: "user",
            reviewerPrincipalId: actorId,
            verdict: request.verdict,
            risks: null,
            unprovenItems: [],
            comments: request.comments.trim() || null,
          }, idempotencyKey);
        case "accept_submission":
          return targetsApi.acceptSubmission(workspaceId, {
            submissionId: request.submissionId,
            reviewId: request.reviewId,
          }, idempotencyKey);
        case "approve_action":
          return targetsApi.approveAction(workspaceId, request.action.id, {
            actionRequestId: request.action.id,
            approverPrincipalType: "user",
            approverPrincipalId: actorId,
            paramsHash: request.action.paramsHash,
          }, idempotencyKey);
        case "execute_action":
          return targetsApi.executeAction(workspaceId, request.actionRequestId, {
            actionRequestId: request.actionRequestId,
          }, idempotencyKey);
      }
    },
    onMutate: (envelope) => {
      setLastCommand(envelope);
      setSuccessfulCommand(null);
    },
    onSuccess: async (_result, envelope) => {
      await refreshWorkspace();
      setSuccessfulCommand(envelope.request.id);
    },
  });

  const submitCommand = (request: WorkbenchCommandRequest) => {
    commandMutation.mutate({ request, idempotencyKey: crypto.randomUUID() });
  };

  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  const outboxFailures = useQuery({
    queryKey: ["targets", selectedCompanyId, targetId, "run-outbox-failures"],
    queryFn: () => targetsApi.runOutboxFailures(selectedCompanyId!, targetId!),
    enabled: Boolean(selectedCompanyId && targetId && activeTab === "runs" && !isRevision),
    refetchInterval: 10_000,
  });
  const retryOutbox = useMutation({
    mutationFn: (command: { runId: string; eventId: string; attemptCount: number; idempotencyKey: string }) =>
      targetsApi.retryRunOutbox(selectedCompanyId!, command.runId, {
        eventId: command.eventId, expectedAttemptCount: command.attemptCount,
      }, command.idempotencyKey),
    onSuccess: async () => {
      await outboxFailures.refetch();
      await refreshWorkspace();
    },
  });

  const retryRun = useMutation({
    mutationFn: (runId: string) => targetsApi.createRunAttempt(selectedCompanyId!, runId, {
      runtimeProfile: "host_trusted",
      executor: { principalType: "service", principalId: "verrail-host-runner" },
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
    setGraphCompletionDefinition(null);
    setGraphDeploymentRevisionId("");
  }, [selectedCompanyId, targetId]);

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
  const unboundEvidence = workspace ? workspace.evidence.filter((item) => item.claimId === null) : [];
  const runCommandError = retryOutbox.error ?? retryRun.error ?? cancelRun.error;
  const runCommandFailureDetail = commandFailureDetail(runCommandError);
  const targetCommandFailureDetail = commandFailureDetail(commandMutation.error);
  const latestSubmission = workspace?.submissions[0] ?? null;
  const latestReview = latestSubmission
    ? workspace?.reviews.find((review) => review.submissionId === latestSubmission.id) ?? null
    : null;

  const invokeProjectedCommand = (command: TargetAvailableCommandV1) => {
    if (!workspace || command.state !== "available" || !command.resourceId) return;
    switch (command.id) {
      case "activate_graph_revision":
        submitCommand({ id: command.id, graphRevisionId: command.resourceId });
        return;
      case "create_run": {
        const node = workspace.work.find((item) => item.id === command.resourceId);
        if (!workspace.graph?.activeGraphRevisionId || node?.responsiblePrincipal?.principalType !== "agent") return;
        submitCommand({
          id: command.id,
          graphRevisionId: workspace.graph.activeGraphRevisionId,
          workNodeId: node.id,
          deploymentRevisionId: node.responsiblePrincipal.principalId,
        });
        return;
      }
      case "record_review":
        submitCommand({
          id: command.id,
          submissionId: command.resourceId,
          verdict: reviewVerdict,
          comments: reviewComments,
        });
        return;
      case "accept_submission": {
        const review = workspace.reviews.find((item) => item.id === command.resourceId);
        if (!review) return;
        submitCommand({ id: command.id, submissionId: review.submissionId, reviewId: review.id });
        return;
      }
      case "approve_action": {
        const action = workspace.actionRequests.find((item) => item.id === command.resourceId);
        if (!action) return;
        submitCommand({ id: command.id, action });
        return;
      }
      case "execute_action":
        submitCommand({ id: command.id, actionRequestId: command.resourceId });
        return;
      default:
        return;
    }
  };

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
          <div className="xl:hidden">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="target-section-select">
              {t("targets.section")}
            </label>
            <select
              id="target-section-select"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={activeTab}
              onChange={(event) => navigate(`/targets/${target.targetId}/${event.target.value}`)}
            >
              {tabItems.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <div className="hidden xl:block">
            <PageTabBar
              items={tabItems}
              value={activeTab}
              onValueChange={(value) => navigate(`/targets/${target.targetId}/${value}`)}
              align="start"
            />
          </div>
        </Tabs>
      ) : null}

      {(isRevision || activeTab === "overview") ? (
        <div className="space-y-7">
          {!isRevision && workspace ? (
            <section aria-labelledby="target-commands-title" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <h3 id="target-commands-title" className="text-sm font-semibold">{t("targets.commands.title")}</h3>
                <div className="flex items-center gap-2">
                  <Button type="button" size="icon" variant="ghost" onClick={() => void refreshWorkspace()} aria-label={t("targets.commands.refresh")} title={t("targets.commands.refresh")}>
                    <RefreshCw className={cn("h-4 w-4", workspaceQuery.isFetching && "animate-spin")} />
                  </Button>
                  <ToneBadge tone={workspace.outcome.state === "accepted" ? "positive" : workspace.outcome.state === "blocked" ? "danger" : "neutral"}>
                    {t(`targets.outcomes.${workspace.outcome.state}`)}
                  </ToneBadge>
                </div>
              </div>
              <ol className="divide-y divide-border border-b border-border">
                {workspace.availableCommands.map((command) => {
                  const action = command.resourceId
                    ? workspace.actionRequests.find((item) => item.id === command.resourceId) ?? null
                    : null;
                  const runNode = command.resourceId
                    ? workspace.work.find((item) => item.id === command.resourceId) ?? null
                    : null;
                  const isCandidateOnly = command.id === "create_submission" || command.id === "request_pull_request";
                  const isAutomatic = command.id === "reconcile_action";
                  const isPending = commandMutation.isPending && commandMutation.variables?.request.id === command.id;
                  const canInvoke = command.state === "available"
                    && !isCandidateOnly
                    && !isAutomatic
                    && accountIdentitySettled
                    && (command.id !== "create_run" || runNode?.responsiblePrincipal?.principalType === "agent");
                  return (
                    <li key={command.id} className="space-y-3 py-3" data-command-id={command.id}>
                      <div className="flex flex-wrap items-start gap-3">
                        {command.state === "completed" ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                        ) : command.state === "blocked" ? (
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        ) : (
                          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">{t(`targets.commands.names.${command.id}`)}</p>
                            <ToneBadge tone={COMMAND_STATE_TONES[command.state]}>
                              {t(`targets.commands.states.${command.state}`)}
                            </ToneBadge>
                          </div>
                          {command.reason ? <p className="mt-1 text-xs text-muted-foreground">{command.reason}</p> : null}
                          {command.resourceId ? (
                            <div className="mt-1 flex flex-wrap gap-3">
                              <CommandBinding value={command.resourceId} label={t("targets.commands.resource")} />
                              {action ? <CommandBinding value={action.paramsHash} label={t("targets.commands.paramsHash")} /> : null}
                              {action?.approvals.latest ? <CommandBinding value={action.approvals.latest.id} label={t("targets.commands.approval")} /> : null}
                              {command.id === "accept_submission" && latestSubmission ? (
                                <CommandBinding value={latestSubmission.submissionHash} label={t("targets.commands.submissionHash")} />
                              ) : null}
                              {command.id === "accept_submission" && latestReview ? (
                                <CommandBinding value={latestReview.reviewHash} label={t("targets.commands.reviewHash")} />
                              ) : null}
                            </div>
                          ) : null}
                          {isCandidateOnly && command.state === "available" ? (
                            <p className="mt-1 text-xs text-muted-foreground">{t("targets.commands.candidateOnly")}</p>
                          ) : null}
                          {isAutomatic && command.state === "available" ? (
                            <p className="mt-1 text-xs text-muted-foreground">{t("targets.commands.automaticRecovery")}</p>
                          ) : null}
                          {command.id === "create_run" && command.state === "available" && !canInvoke ? (
                            <p className="mt-1 text-xs text-destructive">{t("targets.commands.agentBindingRequired")}</p>
                          ) : null}
                        </div>
                        {command.id !== "create_graph_revision" && canInvoke ? (
                          <Button
                            type="button"
                            size="sm"
                            variant={command.id === "execute_action" ? "default" : "outline"}
                            onClick={() => invokeProjectedCommand(command)}
                            disabled={commandMutation.isPending}
                          >
                            {isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : command.id === "create_run" ? <Play className="h-4 w-4" /> : command.id === "approve_action" || command.id === "accept_submission" || command.id === "record_review" ? <UserCheck className="h-4 w-4" /> : command.id === "execute_action" ? <GitPullRequest className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                            {isPending ? t("targets.commands.pending") : t(`targets.commands.actions.${command.id}`)}
                          </Button>
                        ) : null}
                      </div>
                      {command.id === "create_graph_revision" && command.state === "available" ? (
                        <div className="flex flex-wrap items-end gap-2 pl-7">
                          <label className="w-full min-w-0 text-xs font-medium">
                            <span className="mb-1 block text-muted-foreground">{t("targets.commands.deliveryCompletion")}</span>
                            <textarea
                              className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={t("targets.commands.deliveryCompletion")}
                              rows={3}
                              maxLength={4000}
                              value={deliveryCompletion}
                              onChange={(event) => setGraphCompletionDefinition(event.target.value)}
                              disabled={commandMutation.isPending}
                            />
                          </label>
                          <label className="min-w-52 flex-1 text-xs font-medium">
                            <span className="mb-1 block text-muted-foreground">{t("targets.commands.deploymentRevision")}</span>
                            <select
                              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={selectedDeploymentRevisionId}
                              onChange={(event) => setGraphDeploymentRevisionId(event.target.value)}
                              aria-label={t("targets.commands.deploymentRevision")}
                              disabled={agentLifecycleQuery.isLoading || deploymentRevisionOptions.length === 0}
                            >
                              {deploymentRevisionOptions.length === 0 ? (
                                <option value="">{t("targets.commands.noActiveDeployment")}</option>
                              ) : deploymentRevisionOptions.map((option) => (
                                <option key={option.id} value={option.id}>{option.label}</option>
                              ))}
                            </select>
                          </label>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!selectedDeploymentRevisionId || !deliveryCompletion.trim() || deliveryCompletion.trim().length > 4000 || commandMutation.isPending}
                            onClick={() => submitCommand({ id: "create_graph_revision", deploymentRevisionId: selectedDeploymentRevisionId, completionDefinition: deliveryCompletion.trim() })}
                          >
                            {isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            {isPending ? t("targets.commands.pending") : t("targets.commands.actions.create_graph_revision")}
                          </Button>
                        </div>
                      ) : null}
                      {command.id === "record_review" && command.state === "available" ? (
                        <div className="grid gap-2 pl-7 sm:grid-cols-2">
                          <label className="text-xs font-medium">
                            <span className="mb-1 block text-muted-foreground">{t("targets.commands.reviewVerdict")}</span>
                            <select
                              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={reviewVerdict}
                              onChange={(event) => setReviewVerdict(event.target.value as AdjudicationReviewVerdict)}
                            >
                              {(["approved", "changes_requested", "rejected"] as const).map((verdict) => (
                                <option key={verdict} value={verdict}>{t(`targets.adjudication.reviewVerdicts.${verdict}`)}</option>
                              ))}
                            </select>
                          </label>
                          <label className="text-xs font-medium">
                            <span className="mb-1 block text-muted-foreground">{t("targets.commands.reviewComments")}</span>
                            <input
                              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={reviewComments}
                              onChange={(event) => setReviewComments(event.target.value)}
                              placeholder={t("targets.commands.reviewCommentsPlaceholder")}
                            />
                          </label>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {commandMutation.isPending ? (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  {t("targets.commands.awaitingAuthority")}
                </p>
              ) : null}
              {successfulCommand ? (
                <p role="status" className="flex items-center gap-2 text-xs text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  {t("targets.commands.success", { command: t(`targets.commands.names.${successfulCommand}`) })}
                </p>
              ) : null}
              {commandMutation.isError ? (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  <span>{targetCommandFailureDetail ? t("targets.commands.failedDetail", { detail: targetCommandFailureDetail }) : t("targets.commands.failed")}</span>
                  {lastCommand ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => commandMutation.mutate(lastCommand)}>
                      <RefreshCw className="h-4 w-4" />
                      {t("common.retry")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

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
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{index + 1}. {criterion.title}</p>
                        {!isRevision ? <CriterionProofEditor criterion={criterion} targetRevisionId={target.activeTargetRevisionId} disabled={!accountIdentitySettled} onSave={async (proofContract, expectedTargetRevisionId, idempotencyKey) => {
                          await targetsApi.reviseProof(selectedCompanyId!, target.targetId, { expectedTargetRevisionId, criteria: [{ criterionId: criterion.id, proofContract }] }, idempotencyKey);
                          await refreshWorkspace();
                        }} /> : null}
                      </div>
                      {criterion.description ? <p className="mt-1 text-muted-foreground">{criterion.description}</p> : null}
                      <ul className="mt-2 space-y-2">
                        {(criterion.proofContract?.allOf ?? [{ id: "legacy", kind: "independent_verification" as const, phase: "pre_acceptance" as const, assertions: [] }]).map((requirement) => {
                          const proof = workspace?.criterionProofs?.find((item) => item.criterionId === criterion.id && item.requirementId === requirement.id);
                          return <li key={requirement.id} className="space-y-1">
                            <p className="text-xs text-muted-foreground">{t(`targets.criterionProof.phases.${requirement.phase}`)} · {t(`targets.criterionProof.kinds.${requirement.kind}`)} · {t(`targets.criterionProof.states.${proof?.state ?? "required"}`)}</p>
                            {requirement.kind === "independent_verification" ? requirement.assertions.map((assertion) => <p key={assertion} className="text-sm">{assertion}</p>) : null}
                            {proof?.resourceIds.map((id) => <Link key={id} to={`/targets/${target.targetId}/${requirement.kind === "human_governance" ? "acceptance" : requirement.kind === "pull_request_effect" ? "submission" : "evidence"}`} className="mr-2 break-all font-mono text-xs text-muted-foreground underline">{id}</Link>)}
                          </li>;
                        })}
                      </ul>
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
              {workspace.submissions.map((submission) => {
                const submissionReviews = workspace.reviews.filter((review) => review.submissionId === submission.id);
                const submissionAcceptance = workspace.acceptances.find((acceptance) => acceptance.submissionId === submission.id);
                return (
                  <li key={submission.id} className="space-y-4 border-b border-border py-4 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-xs text-muted-foreground" title={submission.submissionHash}>
                        {truncateFact(submission.submissionHash)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground">
                          {submission.submittedBy.principalId} · {formatDateTime(submission.createdAt)}
                        </p>
                      </div>
                      {submissionAcceptance ? <AcceptanceChip acceptance={submissionAcceptance} /> : null}
                    </div>
                    {submission.commitRef || submission.environmentSummary || submission.notes ? (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        {submission.commitRef ? (
                          <p className="min-w-0 truncate font-mono" title={submission.commitRef}>
                            {truncateFact(submission.commitRef)}
                          </p>
                        ) : null}
                        {submission.environmentSummary ? <p>{submission.environmentSummary}</p> : null}
                        {submission.notes ? <p>{submission.notes}</p> : null}
                      </div>
                    ) : null}
                    {submissionReviews.length ? <DeliveryReviewList reviews={submissionReviews} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "artifacts" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.artifacts")}>
          {workspace?.artifacts.length ? (
            <ul className="border-y border-border">
              {workspace.artifacts.map((artifact) => (
                <li key={artifact.id} className="space-y-4 border-b border-border py-4 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <ToneBadge tone="neutral">{t(`targets.assurance.artifactKinds.${artifact.kind}`)}</ToneBadge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{artifact.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {artifact.createdBy.principalId} · {formatDateTime(artifact.createdAt)}
                      </p>
                    </div>
                  </div>
                  {artifact.revisions.length ? (
                    <ol className="divide-y divide-border border-t border-border">
                      {artifact.revisions.map((revision) => (
                        <li key={revision.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-muted-foreground">
                          <span className="font-medium">{t("targets.assurance.revision", { number: revision.revisionNumber })}</span>
                          <span className="font-mono" title={revision.contentHash}>{truncateFact(revision.contentHash)}</span>
                          <span className="min-w-0 truncate font-mono" title={revision.contentRef}>{truncateFact(revision.contentRef)}</span>
                          {revision.contentRef === `storage:${selectedCompanyId}/verrail/run-artifacts/sha256/${revision.contentHash}` ? (
                            <Button asChild variant="ghost" size="icon" title={t("targets.assurance.downloadArtifact")}>
                              <a href={`/api/workspaces/${selectedCompanyId}/artifact-revisions/${revision.id}/content`} aria-label={t("targets.assurance.downloadArtifact")}>
                                <Download className="size-4" />
                              </a>
                            </Button>
                          ) : null}
                          {revision.sourceRunId ? (
                            <span className="font-mono" title={revision.sourceRunId}>
                              {t("targets.assurance.sourceRun", { id: revision.sourceRunId.slice(0, 8) })}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "evidence" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.evidence")}>
          {workspace && (workspace.claims.length > 0 || workspace.evidence.length > 0) ? (
            <div className="space-y-6">
              {workspace.claims.length ? (
                <ul className="border-y border-border">
                  {workspace.claims.map((claim) => {
                    const claimResults = workspace.verificationResults.filter((result) => result.claimId === claim.id);
                    const claimEvidence = workspace.evidence.filter((item) => item.claimId === claim.id);
                    return (
                      <li key={claim.id} className="space-y-4 border-b border-border py-4 last:border-b-0">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{claim.title}</p>
                            <p className="mt-1 font-mono text-xs text-muted-foreground">{claim.criterionKey}</p>
                          </div>
                          <ToneBadge tone={CLAIM_STATUS_TONES[claim.status]}>
                            {t(`targets.assurance.claimStatuses.${claim.status}`)}
                          </ToneBadge>
                        </div>
                        {claimResults.length ? (
                          <ul className="space-y-2">
                            {claimResults.map((result) => (
                              <li key={result.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                <ToneBadge tone={VERDICT_TONES[result.verdict]}>
                                  {t(`targets.assurance.verdicts.${result.verdict}`)}
                                </ToneBadge>
                                <span className="font-mono">{t("targets.assurance.verifier", { version: result.verifierVersion })}</span>
                                <span>{t("targets.assurance.evidenceCount", { count: result.evidenceIds.length })}</span>
                                {result.waiverReference ? (
                                  <span className="min-w-0 truncate" title={result.waiverReference}>
                                    {t("targets.assurance.waiver", { reference: result.waiverReference })}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {claimEvidence.length ? <EvidenceList items={claimEvidence} /> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {unboundEvidence.length ? (
                <section aria-labelledby="target-unbound-evidence-title" className="space-y-3">
                  <h3 id="target-unbound-evidence-title" className="text-sm font-semibold">{t("targets.assurance.unbound")}</h3>
                  <div className="border-y border-border">
                    <EvidenceList items={unboundEvidence} />
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "acceptance" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.acceptance")}>
          {workspace?.acceptances.length ? (
            <ul className="border-y border-border">
              {workspace.acceptances.map((acceptance) => {
                const acceptedSubmission = workspace.submissions.find((submission) => submission.id === acceptance.submissionId);
                const submissionRef = acceptedSubmission?.submissionHash ?? acceptance.submissionId;
                return (
                  <li key={acceptance.id} className="space-y-4 border-b border-border py-4 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <ToneBadge tone="neutral">{t(`targets.adjudication.authorities.${acceptance.authority}`)}</ToneBadge>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{acceptance.acceptedBy.principalId}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(acceptance.createdAt)}</p>
                      </div>
                      <ToneBadge tone={ACCEPTANCE_VALIDITY_TONES[acceptance.validity]}>
                        {t(acceptanceValidityLabelKey(acceptance))}
                      </ToneBadge>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="min-w-0 truncate font-mono" title={submissionRef}>
                        {t("targets.adjudication.submissionRef", { hash: truncateFact(submissionRef) })}
                      </span>
                      <span className="font-mono" title={acceptance.reviewId}>
                        {t("targets.adjudication.reviewRef", { id: truncateFact(acceptance.reviewId) })}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </WorkspaceSectionState>
      ) : null}

      {activeTab === "runs" && !isRevision ? (
        <WorkspaceSectionState loading={workspaceQuery.isLoading} error={workspaceQuery.isError} empty={t("targets.emptyTabs.runs")}>
          {outboxFailures.isError ? (
            <div role="alert" className="flex items-center gap-3 border-b border-border py-3 text-sm text-destructive">
              <span className="min-w-0 flex-1">{t("targets.execution.outboxLoadFailed")}</span>
              <Button variant="ghost" size="icon-sm" title={t("common.retry")} aria-label={t("common.retry")} onClick={() => void outboxFailures.refetch()}><RefreshCw className="h-4 w-4" /></Button>
            </div>
          ) : null}
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
                  {(outboxFailures.data ?? []).filter((event) => event.runId === run.id).map((event) => (
                    <div key={event.eventId} className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
                      <div className="min-w-0 flex-1 text-xs">
                        <p className="font-medium text-destructive">{t("targets.execution.outboxFailed")}</p>
                        <p className="break-all font-mono text-muted-foreground">{event.eventType} · {event.eventId}</p>
                        {event.lastError ? <p className="break-words text-destructive">{event.lastError}</p> : null}
                      </div>
                      <Button size="sm" variant="outline" disabled={retryOutbox.isPending} onClick={() => {
                        const previous = retryOutbox.variables;
                        const idempotencyKey = previous?.eventId === event.eventId && previous.attemptCount === event.attemptCount
                          ? previous.idempotencyKey : crypto.randomUUID();
                        retryOutbox.mutate({ runId: run.id, eventId: event.eventId, attemptCount: event.attemptCount, idempotencyKey });
                      }}><RefreshCw className="h-4 w-4" />{t("targets.execution.retryOutbox")}</Button>
                    </div>
                  ))}
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
