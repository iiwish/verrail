import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, History, Pause, Play, ShieldCheck } from "lucide-react";
import { isWorkspaceDirector, type Agent, type AgentVersionV1, type EvaluationRunStatus } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { agentLifecycleApi } from "@/api/agentLifecycle";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

function useAgentLifecycle(agent: Agent) {
  return useQuery({ queryKey: queryKeys.agentLifecycle(agent.companyId), queryFn: () => agentLifecycleApi.get(agent.companyId) });
}

export function AgentEffectiveVersionStatus({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const query = useAgentLifecycle(agent);
  const definition = query.data?.definitions.find((item) => item.compatibilityAgentId === agent.id);
  const primary = definition?.deployments.find((item) => item.isPrimary);
  const current = definition?.versions.find((item) => item.id === primary?.activeRevision?.agentVersionId);
  const latest = definition?.versions.at(-1);
  if (!latest) return null;
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span>{current ? t(primary?.status === "active" ? "agentActivation.effective" : "agentActivation.pausedVersion", { version: current.versionNumber }) : t("agentActivation.notActive")}</span>
  </div>;
}

export function AgentVersions({ agent, publicationAction }: { agent: Agent; publicationAction?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const query = useAgentLifecycle(agent);
  const client = useQueryClient();
  const [dialog, setDialog] = useState<{ kind: "activate" | "evaluate" | "pause"; version: AgentVersionV1 } | null>(null);
  const [evaluationStatus, setEvaluationStatus] = useState<EvaluationRunStatus>("inconclusive");
  const [safetyPassed, setSafetyPassed] = useState(false);
  const [summary, setSummary] = useState("");
  const [observed, setObserved] = useState<{ primary: string; revisions: Record<string, string> }>({ primary: "none", revisions: {} });
  const idempotencyKey = useRef(crypto.randomUUID());
  const definition = query.data?.definitions.find((item) => item.compatibilityAgentId === agent.id);
  const primary = definition?.deployments.find((item) => item.isPrimary);
  const latest = definition?.versions.at(-1);
  const current = definition?.versions.find((item) => item.id === primary?.activeRevision?.agentVersionId);
  const passing = (id: string) => [...(definition?.evaluations ?? [])].reverse().find((item) => item.candidateAgentVersionId === id && item.status === "passed" && item.safetyStatus === "passed");
  const portable = (version: AgentVersionV1) => version.supplyChain?.source === "saved_agent_configuration.v2" && !["unconfigured", "runtime_default"].includes(version.model);
  const open = (kind: "activate" | "evaluate" | "pause", version: AgentVersionV1) => {
    mutation.reset(); idempotencyKey.current = crypto.randomUUID();
    setObserved({ primary: primary?.id ?? "none", revisions: Object.fromEntries((definition?.deployments ?? []).flatMap((item) => item.activeRevision ? [[item.id, item.activeRevision.id]] : [])) });
    setEvaluationStatus("inconclusive"); setSafetyPassed(false); setSummary(""); setDialog({ kind, version });
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (!definition || !dialog) return;
      const key = idempotencyKey.current;
      if (dialog.kind === "evaluate") return agentLifecycleApi.recordEvaluation(agent.companyId, {
        candidateAgentVersionId: dialog.version.id, status: evaluationStatus, safetyStatus: safetyPassed ? "passed" : "not_run", summary,
      }, key);
      if (dialog.kind === "pause" && primary?.activeRevision) return agentLifecycleApi.reviseDeployment(agent.companyId, primary.id, {
        action: "pause", expectedDeploymentRevisionId: observed.revisions[primary.id],
      }, key);
      const evaluation = passing(dialog.version.id);
      if (!evaluation || !portable(dialog.version)) throw new Error(t("agentActivation.validationRequired"));
      if (observed.primary !== "none") return agentLifecycleApi.reviseDeployment(agent.companyId, observed.primary, {
        action: "activate", agentVersionId: dialog.version.id, evaluationRunId: evaluation.id,
        expectedDeploymentRevisionId: observed.revisions[observed.primary], expectedPrimaryDeploymentId: observed.primary,
      }, key);
      return agentLifecycleApi.createDeployment(agent.companyId, { agentDefinitionId: definition.id, agentVersionId: dialog.version.id, evaluationRunId: evaluation.id, name: `${agent.name} (${agent.id.slice(0, 8)})`, runtimeConfig: {} }, key);
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.agentLifecycle(agent.companyId) }); setDialog(null); },
  });
  if (query.isLoading) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (query.isError) return <div role="alert" className="space-y-3 text-sm"><p className="text-destructive">{query.error.message}</p><Button onClick={() => void query.refetch()} variant="outline">{t("common.retry")}</Button></div>;
  if (!definition || !latest) return <div className="space-y-4">{publicationAction}<p className="text-sm text-muted-foreground">{t("agentPublication.noVersions")}</p></div>;
  const isLatest = primary?.status === "active" && current?.id === latest.id;
  return <div className="space-y-6" data-testid="agent-effective-versions">
    <section className="space-y-4 border-b pb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium">{t("agentActivation.current")}</h2>{current ? <><Badge variant="secondary">v{current.versionNumber}</Badge><Badge variant="outline">{t(`agentPublication.statuses.${primary!.status}`)}</Badge><span className="text-sm text-muted-foreground">{current.model}</span></> : <span className="text-sm text-muted-foreground">{t("agentActivation.notActive")}</span>}</div>
        <div className="flex flex-wrap gap-2">
          {publicationAction}
          {current && primary?.status === "active" && <Button variant="ghost" size="sm" onClick={() => open("pause", current)}><Pause className="size-4" />{t("agentActivation.pauseRequests")}</Button>}
          <Button size="sm" disabled={isLatest} onClick={() => open("activate", latest)}>{isLatest ? <Check className="size-4" /> : <Play className="size-4" />}{isLatest ? t("agentActivation.upToDate") : current ? t(primary?.status === "paused" && latest.id === current.id ? "agentActivation.resumeVersion" : "agentActivation.update", { version: latest.versionNumber }) : t("agentActivation.first")}</Button>
        </div>
      </div>
      {agent.status === "paused" && <p className="text-sm text-destructive">{t("agentActivation.agentPaused")}</p>}
      {!isLatest && <p className="text-sm text-muted-foreground">{!portable(latest) ? t("agentActivation.republish") : !passing(latest.id) ? t("agentActivation.validationRequired") : t("agentActivation.ready", { version: latest.versionNumber })}</p>}
      <p className="text-xs text-muted-foreground">{t("agentActivation.boundary")}</p>
      {!isWorkspaceDirector(agent.metadata) && <p className="break-all text-xs text-muted-foreground">{String(primary?.activeRevision?.runtimeConfig.cwd ?? agent.adapterConfig.cwd ?? t("agentPublication.unboundWorkspace"))}</p>}
    </section>
    <section><h2 className="mb-3 flex items-center gap-2 text-sm font-medium"><History className="size-4" />{t("agentPublication.history")}</h2>
      {[...definition.versions].reverse().map((version) => <div key={version.id} className="border-t py-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">v{version.versionNumber}</span>{version.id === current?.id && <Badge variant="secondary">{t("agentActivation.current")}</Badge>}<span>{version.model}</span><span className="text-xs text-muted-foreground">{new Date(version.createdAt).toLocaleString(i18n.resolvedLanguage)}</span><Badge variant="outline">{passing(version.id) ? t("agentActivation.validated") : t("agentActivation.unvalidated")}</Badge></div>
          <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" onClick={() => open("evaluate", version)}><ShieldCheck className="size-4" />{t("agentLifecycle.evaluate")}</Button><Button variant="outline" size="sm" disabled={current?.id === version.id && primary?.status === "active"} onClick={() => open("activate", version)}>{current && version.versionNumber < current.versionNumber ? t("agentActivation.rollback", { version: version.versionNumber }) : t("agentActivation.useVersion")}</Button></div>
        </div>
        <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted-foreground">{t("agentPublication.snapshot")}</summary><pre className="mt-2 whitespace-pre-wrap break-words bg-muted p-3 text-xs">{JSON.stringify(version, null, 2)}</pre></details>
        <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted-foreground">{t("agentPublication.validationHistory")}</summary>{definition.evaluations.filter((item) => item.candidateAgentVersionId === version.id).map((item) => <p className="mt-2 whitespace-pre-wrap break-words text-xs" key={item.id}>{t(`agentLifecycle.evaluationStatuses.${item.status}`)} · {t(`agentLifecycle.safetyStatuses.${item.safetyStatus}`)} · {item.summary}</p>)}</details>
      </div>)}
    </section>
    <Dialog open={!!dialog} onOpenChange={(value) => { if (!value && !mutation.isPending) setDialog(null); }}><DialogContent className="max-h-screen overflow-y-auto">
      <DialogHeader><DialogTitle>{dialog?.kind === "evaluate" ? t("agentLifecycle.evaluateDialog") : dialog?.kind === "pause" ? t("agentActivation.pauseTitle") : t("agentActivation.confirmTitle", { version: dialog?.version.versionNumber })}</DialogTitle><DialogDescription>{t("agentActivation.boundary")}</DialogDescription></DialogHeader>
      {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
      {dialog?.kind === "activate" && <div className="space-y-3 text-sm">
        <p>{current ? `v${current.versionNumber} → v${dialog.version.versionNumber}` : t("agentActivation.first")}</p>
        {!portable(dialog.version) ? <p className="text-destructive">{t("agentActivation.republish")}</p> : !passing(dialog.version.id) ? <div className="space-y-2"><p>{t("agentActivation.validationRequired")}</p><Button variant="outline" onClick={() => open("evaluate", dialog.version)}>{t("agentLifecycle.evaluate")}</Button></div> : <p>{t("agentActivation.validated")}</p>}
        {!isWorkspaceDirector(agent.metadata) && <p>{t("agentActivation.environmentSettings")} <Link className="underline" to={`/agents/${agent.id}/configuration`}>{t("agentProduct.sections.settings")}</Link></p>}
      </div>}
      {dialog?.kind === "evaluate" && <div className="space-y-3 text-sm"><label className="grid gap-1">{t("agentLifecycle.evaluation.status")}<select className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={evaluationStatus} onChange={(event) => setEvaluationStatus(event.target.value as EvaluationRunStatus)}>{(["inconclusive", "passed", "failed"] as const).map((status) => <option value={status} key={status}>{t(`agentLifecycle.evaluationStatuses.${status}`)}</option>)}</select></label><label className="flex items-center gap-2"><input type="checkbox" checked={safetyPassed} onChange={(event) => setSafetyPassed(event.target.checked)} />{t("agentActivation.safetyPassed")}</label><label className="grid gap-1">{t("common.summary")}<Textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label></div>}
      <DialogFooter><Button variant="outline" disabled={mutation.isPending} onClick={() => setDialog(null)}>{t("common.cancel")}</Button><Button disabled={mutation.isPending || !dialog || (dialog.kind === "activate" && (!portable(dialog.version) || !passing(dialog.version.id))) || (dialog.kind === "evaluate" && (!summary.trim() || (evaluationStatus === "passed" && !safetyPassed)))} onClick={() => mutation.mutate()}>{mutation.isPending ? t("common.saving") : t("common.confirm")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
