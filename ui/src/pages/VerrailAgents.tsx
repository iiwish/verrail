import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Pause, Play, Plus, RotateCcw, Rocket, ShieldCheck, Star } from "lucide-react";
import type { AgentDefinitionV1, DeploymentV1, EvaluationRunStatus } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { agentLifecycleApi } from "@/api/agentLifecycle";
import { projectsApi } from "@/api/projects";
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
  | { kind: "evaluate"; definition: AgentDefinitionV1 }
  | { kind: "deploy"; definition: AgentDefinitionV1 }
  | null;

type SafetyStatus = "passed" | "failed" | "not_run";

const EVALUATION_STATUSES: readonly EvaluationRunStatus[] = ["passed", "failed", "inconclusive"];
const SAFETY_STATUSES: readonly SafetyStatus[] = ["passed", "failed", "not_run"];

function field(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }
function optionalMetric(form: FormData, name: string) {
  const value = field(form, name);
  return value === "" ? null : Number(value);
}

export function VerrailAgents({ agentId, director = false }: { agentId?: string; director?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<LifecycleDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [evaluationStatus, setEvaluationStatus] = useState<EvaluationRunStatus>("inconclusive");
  const [safetyStatus, setSafetyStatus] = useState<SafetyStatus>("not_run");
  const [projectId, setProjectId] = useState("");
  const [versionId, setVersionId] = useState("");
  const projects = useQuery({ queryKey: ["deployment-projects", selectedCompanyId], queryFn: () => projectsApi.list(selectedCompanyId!), enabled: Boolean(selectedCompanyId) && dialog?.kind === "deploy" });
  const workspaces = useQuery({ queryKey: ["deployment-workspaces", selectedCompanyId, projectId], queryFn: () => projectsApi.listWorkspaces(projectId, selectedCompanyId!), enabled: Boolean(selectedCompanyId && projectId) && dialog?.kind === "deploy" });
  // Idempotency key is per dialog open, reused across re-submits until success.
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());
  const openDialog = (next: LifecycleDialog) => {
    setError(null);
    setProjectId("");
    const versions = next && next.kind !== "definition" ? next.definition.versions : [];
    const selected = next?.kind === "deploy" ? [...versions].reverse().find((version) => next.definition.evaluations.some((evaluation) => evaluation.candidateAgentVersionId === version.id && evaluation.status === "passed" && evaluation.safetyStatus === "passed")) : versions.at(-1);
    setVersionId(selected?.id ?? "");
    idempotencyKeyRef.current = crypto.randomUUID();
    if (next?.kind === "evaluate") {
      setEvaluationStatus("inconclusive");
      setSafetyStatus("not_run");
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
  const definitions = model?.definitions.filter((definition) => !agentId || definition.compatibilityAgentId === agentId) ?? [];
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
    const latestVersion = dialog.definition.versions.find((version) => version.id === versionId);
    if (dialog.kind === "evaluate" && latestVersion) {
      mutation.mutate(() => agentLifecycleApi.recordEvaluation(selectedCompanyId, {
        candidateAgentVersionId: latestVersion.id,
        baselineAgentVersionId: dialog.definition.versions.find((version) => version.versionNumber === latestVersion.versionNumber - 1)?.id ?? null,
        status: evaluationStatus,
        qualityScore: optionalMetric(form, "quality"),
        costCents: optionalMetric(form, "cost"),
        latencyMs: optionalMetric(form, "latency"),
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
        runtimeConfig: { projectWorkspaceId: field(form, "projectWorkspaceId") },
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
    <main className={agentId ? "space-y-5" : "mx-auto w-full max-w-6xl px-6 py-6"}>
      {!agentId && <header className="mb-6 flex items-start justify-between gap-4 border-b pb-5">
        <div>
          <h1 className="text-xl font-semibold">{t("agentLifecycle.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("agentLifecycle.subtitle")}</p>
        </div>
        <Button onClick={() => openDialog({ kind: "definition" })}><Plus className="size-4" />{t("agentLifecycle.newDefinition")}</Button>
      </header>}
      {director && <p className="text-sm text-muted-foreground">{t("agentPublication.directorBoundary")}</p>}
      {error && <InlineBanner tone="danger" title={t("agentLifecycle.commandFailed")}>{error}</InlineBanner>}
      {definitions.length === 0 ? (
        <EmptyState icon={Bot} title={t("agentPublication.noVersions")} message={t("agentPublication.noVersionsBody")} />
      ) : (
        <div className="divide-y border-y">
          {definitions.map((definition) => {
            const latest = definition.versions.at(-1);
            const latestPassed = latest && [...definition.evaluations].reverse().find((evaluation) => evaluation.candidateAgentVersionId === latest.id && evaluation.status === "passed" && evaluation.safetyStatus === "passed");
            const hasDeployableVersion = definition.versions.some((version) => definition.evaluations.some((evaluation) => evaluation.candidateAgentVersionId === version.id && evaluation.status === "passed" && evaluation.safetyStatus === "passed"));
            return (
              <section key={definition.id} className="py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    {agentId ? <h2 className="text-sm font-medium">{t("agentLifecycle.deployments")}</h2> : <><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{definition.name}</h2><Badge variant="outline">{t(`agentPublication.statuses.${definition.status}`)}</Badge>{latest && <Badge variant="secondary">v{latest.versionNumber}</Badge>}</div><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{definition.description || t("agentLifecycle.noDescription")}</p></>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!agentId && <Button variant="outline" size="sm" onClick={() => openDialog({ kind: "definition", definition })}>{t("common.edit")}</Button>}
                    <Button variant="outline" size="sm" disabled={!latest} onClick={() => openDialog({ kind: "evaluate", definition })}><ShieldCheck className="size-4" />{t("agentLifecycle.evaluate")}</Button>
                    {!director && <Button size="sm" disabled={!hasDeployableVersion || mutation.isPending} onClick={() => openDialog({ kind: "deploy", definition })}><Rocket className="size-4" />{t("agentLifecycle.deploy")}</Button>}
                  </div>
                </div>
                {!agentId && latest && <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.runtime")}</dt><dd>{latest.runtime}</dd></div><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.model")}</dt><dd>{latest.model}</dd></div><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.contentHash")}</dt><dd className="font-mono">{latest.contentHash.slice(0, 12)}</dd></div></dl>}
                <div className="mt-5">
                  {!agentId && <h3 className="mb-2 text-sm font-medium">{t("agentLifecycle.deployments")}</h3>}
                  {definition.deployments.length === 0 ? <p className="text-sm text-muted-foreground">{t("agentLifecycle.noDeployments")}</p> : definition.deployments.map((deployment) => (
                    <div key={deployment.id} className="flex flex-wrap items-center justify-between gap-3 border-t py-3 text-sm">
                      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="break-words font-medium">{deployment.name}</span><Badge variant="outline">{t(`agentPublication.statuses.${deployment.status}`)}</Badge>{deployment.isDefault && <Badge><Star className="size-3" />{t("agentLifecycle.default")}</Badge>}<span>v{definition.versions.find((version) => version.id === deployment.activeRevision?.agentVersionId)?.versionNumber ?? "-"}</span><span className="text-muted-foreground">r{deployment.activeRevision?.revisionNumber ?? 0}</span></div><p className="mt-1 break-all text-xs text-muted-foreground">{typeof deployment.activeRevision?.runtimeConfig.cwd === "string" ? deployment.activeRevision.runtimeConfig.cwd : t("agentPublication.unboundWorkspace")}</p></div>
                      <div className="flex flex-wrap gap-2">
                        {!director && latest && latestPassed && deployment.status !== "retired" && deployment.activeRevision?.agentVersionId !== latest.id && <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(() => agentLifecycleApi.reviseDeployment(selectedCompanyId, deployment.id, { action: "upgrade", agentVersionId: latest.id, evaluationRunId: latestPassed.id }, crypto.randomUUID()))}><Rocket className="size-4" />{t("agentPublication.upgrade", { version: latest.versionNumber })}</Button>}
                        {!deployment.isDefault && deployment.status === "active" && <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => revise(deployment, "set_default")}><Star className="size-4" />{t("agentLifecycle.setDefault")}</Button>}
                        {deployment.status === "active" ? <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => revise(deployment, "pause")}><Pause className="size-4" />{t("agentLifecycle.pause")}</Button> : !director && deployment.status === "paused" && <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => revise(deployment, "resume")}><Play className="size-4" />{t("agentLifecycle.resume")}</Button>}
                        {!director && deployment.status !== "retired" && deployment.revisions.length > 1 && <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => revise(deployment, "rollback")}><RotateCcw className="size-4" />{t("agentLifecycle.rollback")}</Button>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-5 border-t pt-4">
                  <h3 className="mb-2 text-sm font-medium">{t("agentPublication.history")}</h3>
                  {[...definition.versions].reverse().map((version) => <details key={version.id} className="border-t py-3 text-sm">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3"><span className="font-medium">v{version.versionNumber}</span><span>{version.model}</span><time className="text-muted-foreground">{new Date(version.createdAt).toLocaleString(i18n.resolvedLanguage)}</time><code className="text-xs text-muted-foreground">{version.contentHash.slice(0, 12)}</code></summary>
                    <pre className="mt-3 whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans">{version.prompt}</pre>
                    <p className="mt-2 text-muted-foreground">{t("agentLifecycle.publishFields.skills")}: {version.skills?.join(", ") || "-"}</p>
                    <div className="mt-3 space-y-2"><h4 className="text-sm font-medium">{t("agentPublication.validationHistory")}</h4>{definition.evaluations.filter((evaluation) => evaluation.candidateAgentVersionId === version.id).length === 0 ? <p className="text-muted-foreground">{t("agentPublication.noValidation")}</p> : [...definition.evaluations].reverse().filter((evaluation) => evaluation.candidateAgentVersionId === version.id).map((evaluation) => <div key={evaluation.id} className="border-t pt-2"><div className="flex flex-wrap gap-2"><Badge variant="outline">{t(`agentLifecycle.evaluationStatuses.${evaluation.status}`)}</Badge><span>{t("agentLifecycle.evaluation.safetyStatus")}: {t(`agentLifecycle.safetyStatuses.${evaluation.safetyStatus}`)}</span><time className="text-muted-foreground">{new Date(evaluation.createdAt).toLocaleString(i18n.resolvedLanguage)}</time></div>{evaluation.summary && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{evaluation.summary}</p>}</div>)}</div>
                    <details className="mt-2"><summary className="cursor-pointer">{t("agentPublication.snapshot")}</summary><pre className="mt-2 whitespace-pre-wrap break-words bg-muted p-3 text-xs">{JSON.stringify({ runtime: version.runtime, model: version.model, skills: version.skills, tools: version.tools, outputSchema: version.outputSchema, capabilityCeiling: version.capabilityCeiling, supplyChain: version.supplyChain }, null, 2)}</pre></details>
                  </details>)}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && !mutation.isPending && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dialog?.kind === "definition" ? t("agentLifecycle.definitionDialog") : dialog?.kind === "evaluate" ? t("agentLifecycle.evaluateDialog") : t("agentLifecycle.deployDialog")}</DialogTitle><DialogDescription>{t("agentLifecycle.dialogDescription")}</DialogDescription></DialogHeader>
          <form onSubmit={submit} className="grid gap-4">
            {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            <fieldset disabled={mutation.isPending} className="contents">
            {dialog && dialog.kind !== "definition" && <label className="grid gap-1 text-sm">{t("agentPublication.version")}<select value={versionId} onChange={(event) => setVersionId(event.target.value)} className="h-9 rounded-md border border-border bg-background px-3 text-sm">{[...dialog.definition.versions].reverse().map((version) => <option key={version.id} value={version.id}>v{version.versionNumber} · {version.model}</option>)}</select></label>}
            {dialog?.kind === "definition" && <><label className="grid gap-1 text-sm">{t("common.name")}<Input name="name" required defaultValue={dialog.definition?.name} /></label><label className="grid gap-1 text-sm">{t("common.description")}<Textarea name="description" defaultValue={dialog.definition?.description ?? ""} /></label></>}
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
              <label className="grid gap-1 text-sm">{t("agentLifecycle.quality")}<Input name="quality" type="number" min="0" max="100" /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.cost")}<Input name="cost" type="number" min="0" /></label><label className="grid gap-1 text-sm">{t("agentLifecycle.latency")}<Input name="latency" type="number" min="0" /></label><label className="grid gap-1 text-sm">{t("common.summary")}<Textarea name="summary" /></label>
            </>}
            {dialog?.kind === "deploy" && <>
              <label className="grid gap-1 text-sm">{t("common.name")}<Input name="name" required defaultValue={dialog.definition.name} /></label>
              <label className="grid gap-1 text-sm">{t("agentPublication.project")}<select aria-label={t("agentPublication.project")} className="h-9 rounded-md border border-border bg-background px-3 text-sm" required value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">{t("agentPublication.selectProject")}</option>{projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
              <label className="grid gap-1 text-sm">{t("agentPublication.workspace")}<select aria-label={t("agentPublication.workspace")} key={projectId} className="h-9 rounded-md border border-border bg-background px-3 text-sm" name="projectWorkspaceId" required defaultValue="" disabled={!projectId || workspaces.isFetching}><option value="">{t("agentPublication.selectWorkspace")}</option>{workspaces.data?.filter((workspace) => workspace.sourceType === "local_path" && workspace.cwd).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.cwd}</option>)}</select></label>
              {(projects.isError || workspaces.isError) && <p role="alert" className="text-sm text-destructive">{t("agentPublication.workspaceFailed")}</p>}
              {projectId && workspaces.isSuccess && !workspaces.data.some((workspace) => workspace.sourceType === "local_path" && workspace.cwd) && <p className="text-sm text-muted-foreground">{t("agentPublication.noWorkspaces")}</p>}
              <p className="text-sm text-muted-foreground">{t("agentPublication.workspaceBoundary")}</p>
              <label className="flex items-center gap-2 text-sm"><input name="default" type="checkbox" />{t("agentLifecycle.makeDefault")}</label>
            </>}
            </fieldset>
            <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setDialog(null)}>{t("common.cancel")}</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? t("common.saving") : t("common.confirm")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
