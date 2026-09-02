import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Pause, Play, Plus, RotateCcw, Rocket, ShieldCheck, Star, Upload } from "lucide-react";
import type { AgentDefinitionV1, DeploymentV1, EvaluationRunStatus } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { agentLifecycleApi } from "@/api/agentLifecycle";
import { EmptyState } from "@/components/EmptyState";
import { InlineBanner } from "@/components/InlineBanner";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

type LifecycleDialog =
  | { kind: "definition"; definition?: AgentDefinitionV1 }
  | { kind: "publish"; definition: AgentDefinitionV1 }
  | { kind: "evaluate"; definition: AgentDefinitionV1 }
  | { kind: "deploy"; definition: AgentDefinitionV1 }
  | null;

type SafetyStatus = "passed" | "failed" | "not_run";

const EVALUATION_STATUSES: readonly EvaluationRunStatus[] = ["passed", "failed", "inconclusive"];
const SAFETY_STATUSES: readonly SafetyStatus[] = ["passed", "failed", "not_run"];

function field(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }

export function VerrailAgents() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<LifecycleDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [evaluationStatus, setEvaluationStatus] = useState<EvaluationRunStatus>("passed");
  const [safetyStatus, setSafetyStatus] = useState<SafetyStatus>("passed");
  // Idempotency key is per dialog open, reused across re-submits until success.
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());
  const openDialog = (next: LifecycleDialog) => {
    idempotencyKeyRef.current = crypto.randomUUID();
    if (next?.kind === "evaluate") {
      setEvaluationStatus("passed");
      setSafetyStatus("passed");
    }
    setDialog(next);
  };
  const query = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agentLifecycle(selectedCompanyId) : ["agent-lifecycle", "none"],
    queryFn: () => agentLifecycleApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setError(null);
      setDialog(null);
      if (selectedCompanyId) await queryClient.invalidateQueries({ queryKey: queryKeys.agentLifecycle(selectedCompanyId) });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : t("agentLifecycle.commandFailed")),
  });

  if (!selectedCompanyId) return <EmptyState icon={Bot} message={t("agents.selectCompany")} />;
  if (query.isLoading) return <PageSkeleton variant="list" />;
  if (query.isError) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-6">
        <InlineBanner tone="danger" title={t("agentLifecycle.loadFailed")}>
          {query.error instanceof Error ? query.error.message : t("agentLifecycle.loadFailed")}
        </InlineBanner>
        <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
          {t("common.retry")}
        </Button>
      </main>
    );
  }

  const model = query.data;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog) return;
    const form = new FormData(event.currentTarget);
    if (dialog.kind === "definition") {
      const input = { name: field(form, "name"), description: field(form, "description") || null };
      mutation.mutate(() => dialog.definition
        ? agentLifecycleApi.updateDefinition(selectedCompanyId, dialog.definition.id, input, idempotencyKeyRef.current)
        : agentLifecycleApi.createDefinition(selectedCompanyId, input, idempotencyKeyRef.current));
      return;
    }
    const latestVersion = dialog.definition.versions.at(-1);
    if (dialog.kind === "publish") {
      mutation.mutate(() => agentLifecycleApi.publishVersion(selectedCompanyId, dialog.definition.id, {
        runtime: field(form, "runtime"),
        model: field(form, "model"),
        prompt: field(form, "prompt"),
        skills: field(form, "skills").split(",").map((value) => value.trim()).filter(Boolean),
        tools: field(form, "tools").split(",").map((value) => value.trim()).filter(Boolean),
        outputSchema: {},
        capabilityCeiling: field(form, "capabilities").split(",").map((value) => value.trim()).filter(Boolean),
        supplyChain: {},
      }, idempotencyKeyRef.current));
    } else if (dialog.kind === "evaluate" && latestVersion) {
      mutation.mutate(() => agentLifecycleApi.recordEvaluation(selectedCompanyId, {
        candidateAgentVersionId: latestVersion.id,
        baselineAgentVersionId: dialog.definition.versions.at(-2)?.id ?? null,
        status: evaluationStatus,
        qualityScore: Number(field(form, "quality")),
        costCents: Number(field(form, "cost")),
        latencyMs: Number(field(form, "latency")),
        safetyStatus,
        summary: field(form, "summary") || null,
      }, idempotencyKeyRef.current));
    } else if (dialog.kind === "deploy" && latestVersion) {
      const evaluation = [...dialog.definition.evaluations].reverse().find((item) => item.candidateAgentVersionId === latestVersion.id && item.status === "passed" && item.safetyStatus === "passed");
      if (!evaluation) { setError(t("agentLifecycle.evaluationRequired")); return; }
      mutation.mutate(() => agentLifecycleApi.createDeployment(selectedCompanyId, {
        agentDefinitionId: dialog.definition.id,
        agentVersionId: latestVersion.id,
        evaluationRunId: evaluation.id,
        name: field(form, "name"),
        isDefault: form.get("default") === "on",
        runtimeConfig: {},
      }, idempotencyKeyRef.current));
    }
  };

  const revise = (deployment: DeploymentV1, action: "pause" | "resume" | "rollback" | "set_default") => {
    const source = action === "rollback" ? deployment.revisions.at(-2) : undefined;
    mutation.mutate(() => agentLifecycleApi.reviseDeployment(selectedCompanyId, deployment.id, {
      action,
      ...(source ? { sourceDeploymentRevisionId: source.id } : {}),
    }, crypto.randomUUID()));
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-6">
      <header className="mb-6 flex items-start justify-between gap-4 border-b pb-5">
        <div>
          <h1 className="text-xl font-semibold">{t("agentLifecycle.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("agentLifecycle.subtitle")}</p>
        </div>
        <Button onClick={() => openDialog({ kind: "definition" })}><Plus className="size-4" />{t("agentLifecycle.newDefinition")}</Button>
      </header>
      {error && <InlineBanner tone="danger" title={t("agentLifecycle.commandFailed")}>{error}</InlineBanner>}
      {!model || model.definitions.length === 0 ? (
        <EmptyState icon={Bot} title={t("agentLifecycle.emptyTitle")} message={t("agentLifecycle.emptyBody")} action={t("agentLifecycle.newDefinition")} onAction={() => openDialog({ kind: "definition" })} />
      ) : (
        <div className="divide-y border-y">
          {model.definitions.map((definition) => {
            const latest = definition.versions.at(-1);
            const latestPassed = latest && [...definition.evaluations].reverse().find((evaluation) => evaluation.candidateAgentVersionId === latest.id && evaluation.status === "passed" && evaluation.safetyStatus === "passed");
            return (
              <section key={definition.id} className="py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{definition.name}</h2><Badge variant="outline">{definition.status}</Badge>{latest && <Badge variant="secondary">v{latest.versionNumber}</Badge>}</div>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{definition.description || t("agentLifecycle.noDescription")}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => openDialog({ kind: "definition", definition })}>{t("common.edit")}</Button>
                    <Button variant="outline" size="sm" onClick={() => openDialog({ kind: "publish", definition })}><Upload className="size-4" />{t("agentLifecycle.publish")}</Button>
                    <Button variant="outline" size="sm" disabled={!latest} onClick={() => openDialog({ kind: "evaluate", definition })}><ShieldCheck className="size-4" />{t("agentLifecycle.evaluate")}</Button>
                    <Button size="sm" disabled={!latestPassed} onClick={() => openDialog({ kind: "deploy", definition })}><Rocket className="size-4" />{t("agentLifecycle.deploy")}</Button>
                  </div>
                </div>
                {latest && <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.runtime")}</dt><dd>{latest.runtime}</dd></div><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.model")}</dt><dd>{latest.model}</dd></div><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.contentHash")}</dt><dd className="font-mono">{latest.contentHash.slice(0, 12)}</dd></div></dl>}
                <div className="mt-5">
                  <h3 className="mb-2 text-sm font-medium">{t("agentLifecycle.deployments")}</h3>
                  {definition.deployments.length === 0 ? <p className="text-sm text-muted-foreground">{t("agentLifecycle.noDeployments")}</p> : definition.deployments.map((deployment) => (
                    <div key={deployment.id} className="flex flex-wrap items-center justify-between gap-3 border-t py-3 text-sm">
                      <div className="flex items-center gap-2"><span className="font-medium">{deployment.name}</span><Badge variant="outline">{deployment.status}</Badge>{deployment.isDefault && <Badge><Star className="size-3" />{t("agentLifecycle.default")}</Badge>}<span className="text-muted-foreground">r{deployment.activeRevision?.revisionNumber ?? 0}</span></div>
                      <div className="flex gap-2">
                        {!deployment.isDefault && deployment.status === "active" && <Button variant="ghost" size="sm" onClick={() => revise(deployment, "set_default")}><Star className="size-4" />{t("agentLifecycle.setDefault")}</Button>}
                        {deployment.status === "active" ? <Button variant="ghost" size="sm" onClick={() => revise(deployment, "pause")}><Pause className="size-4" />{t("agentLifecycle.pause")}</Button> : deployment.status === "paused" && <Button variant="ghost" size="sm" onClick={() => revise(deployment, "resume")}><Play className="size-4" />{t("agentLifecycle.resume")}</Button>}
                        {deployment.revisions.length > 1 && <Button variant="ghost" size="sm" onClick={() => revise(deployment, "rollback")}><RotateCcw className="size-4" />{t("agentLifecycle.rollback")}</Button>}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dialog?.kind === "definition" ? t("agentLifecycle.definitionDialog") : dialog?.kind === "publish" ? t("agentLifecycle.publishDialog") : dialog?.kind === "evaluate" ? t("agentLifecycle.evaluateDialog") : t("agentLifecycle.deployDialog")}</DialogTitle><DialogDescription>{t("agentLifecycle.dialogDescription")}</DialogDescription></DialogHeader>
          <form onSubmit={submit} className="grid gap-4">
            {dialog?.kind === "definition" && <><label className="grid gap-1 text-sm">{t("common.name")}<Input name="name" required defaultValue={dialog.definition?.name} /></label><label className="grid gap-1 text-sm">{t("common.description")}<Textarea name="description" defaultValue={dialog.definition?.description ?? ""} /></label></>}
            {dialog?.kind === "publish" && <><label className="grid gap-1 text-sm">{t("agentLifecycle.publishFields.runtime")}<Input name="runtime" required defaultValue="codex-local" /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.publishFields.model")}<Input name="model" required /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.publishFields.prompt")}<Textarea name="prompt" required /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.publishFields.skills")}<Input name="skills" placeholder="skill-a, skill-b" /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.publishFields.tools")}<Input name="tools" placeholder="tool-a, tool-b" /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.publishFields.capabilities")}<Input name="capabilities" /></label></>}
            {dialog?.kind === "evaluate" && <>
              <label className="grid gap-1 text-sm">{t("agentLifecycle.evaluation.status")}
                <select name="status" className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={evaluationStatus} onChange={(event) => setEvaluationStatus(event.target.value as EvaluationRunStatus)}>
                  {EVALUATION_STATUSES.map((value) => <option key={value} value={value}>{t(`agentLifecycle.evaluationStatuses.${value}`)}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-sm">{t("agentLifecycle.evaluation.safetyStatus")}
                <select name="safetyStatus" className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={safetyStatus} onChange={(event) => setSafetyStatus(event.target.value as SafetyStatus)}>
                  {SAFETY_STATUSES.map((value) => <option key={value} value={value}>{t(`agentLifecycle.safetyStatuses.${value}`)}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-sm">{t("agentLifecycle.quality")}<Input name="quality" type="number" min="0" max="100" required defaultValue="90" /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.cost")}<Input name="cost" type="number" min="0" required defaultValue="0" /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.latency")}<Input name="latency" type="number" min="0" required defaultValue="0" /></label><label className="grid gap-1 text-sm">{t("common.summary")}<Textarea name="summary" /></label>
            </>}
            {dialog?.kind === "deploy" && <><label className="grid gap-1 text-sm">{t("common.name")}<Input name="name" required defaultValue={`${dialog.definition.name} production`} /></label><label className="flex items-center gap-2 text-sm"><input name="default" type="checkbox" />{t("agentLifecycle.makeDefault")}</label></>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(null)}>{t("common.cancel")}</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? t("common.saving") : t("common.confirm")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
