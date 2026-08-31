import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateTargetInputV1 } from "@paperclipai/shared";
import { AlertCircle, LoaderCircle, Plus, Target, X } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { projectsApi } from "../api/projects";
import { targetsApi } from "../api/targets";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useTranslation } from "../i18n";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type CriterionDraft = { key: string; title: string; description: string };

function freshCriterion(): CriterionDraft {
  return { key: crypto.randomUUID(), title: "", description: "" };
}

function errorCode(error: unknown) {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  const code = (error.body as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function NewTargetDialog() {
  const { t } = useTranslation();
  const { newTargetOpen, newTargetDefaults, closeNewTarget } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [ownerValue, setOwnerValue] = useState("");
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [criteria, setCriteria] = useState<CriterionDraft[]>(() => [freshCriterion()]);
  const [riskLevel, setRiskLevel] = useState<CreateTargetInputV1["riskLevel"]>("medium");
  const [deadline, setDeadline] = useState("");
  const [policySummary, setPolicySummary] = useState("");

  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.all(selectedCompanyId) : ["projects", "disabled"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && newTargetOpen),
  });
  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "disabled"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && newTargetOpen),
  });
  const usersQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.access.companyUserDirectory(selectedCompanyId)
      : ["access", "users", "disabled"],
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && newTargetOpen),
  });

  const activeProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.archivedAt),
    [projectsQuery.data],
  );
  const activeAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated"),
    [agentsQuery.data],
  );

  useEffect(() => {
    if (!newTargetOpen || projectId) return;
    const preferred = newTargetDefaults.projectId;
    if (preferred && activeProjects.some((project) => project.id === preferred)) {
      setProjectId(preferred);
      return;
    }
    if (activeProjects[0]) setProjectId(activeProjects[0].id);
  }, [activeProjects, newTargetDefaults.projectId, newTargetOpen, projectId]);

  useEffect(() => {
    if (!newTargetOpen || ownerValue) return;
    const user = usersQuery.data?.users[0];
    if (user) setOwnerValue(`user:${user.principalId}`);
  }, [newTargetOpen, ownerValue, usersQuery.data?.users]);

  const createTarget = useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: CreateTargetInputV1; idempotencyKey: string }) =>
      targetsApi.create(selectedCompanyId!, input, idempotencyKey),
  });

  const reset = () => {
    setProjectId("");
    setTitle("");
    setSummary("");
    setOwnerValue("");
    setGoal("");
    setConstraints("");
    setCriteria([freshCriterion()]);
    setRiskLevel("medium");
    setDeadline("");
    setPolicySummary("");
    attemptRef.current = null;
    createTarget.reset();
  };

  const validCriteria = criteria.filter((criterion) => criterion.title.trim());
  const canSubmit = Boolean(
    selectedCompanyId
    && projectId
    && title.trim()
    && ownerValue
    && goal.trim()
    && validCriteria.length === criteria.length
    && criteria.length > 0
    && !createTarget.isPending,
  );

  const submit = async () => {
    if (!canSubmit || !selectedCompanyId) return;
    const separator = ownerValue.indexOf(":");
    const principalType = ownerValue.slice(0, separator) as "user" | "agent";
    const principalId = ownerValue.slice(separator + 1);
    const input: CreateTargetInputV1 = {
      projectId,
      title: title.trim(),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      outcomeOwner: { principalType, principalId },
      goal: goal.trim(),
      constraints: constraints.split("\n").map((value) => value.trim()).filter(Boolean),
      acceptanceCriteria: criteria.map((criterion) => ({
        title: criterion.title.trim(),
        ...(criterion.description.trim() ? { description: criterion.description.trim() } : {}),
      })),
      riskLevel,
      ...(deadline ? { deadline } : {}),
      ...(policySummary.trim() ? { policySummary: policySummary.trim() } : {}),
    };
    const fingerprint = JSON.stringify(input);
    if (attemptRef.current?.fingerprint !== fingerprint) {
      attemptRef.current = { fingerprint, key: `target:create:${crypto.randomUUID()}` };
    }
    try {
      const created = await createTarget.mutateAsync({
        input,
        idempotencyKey: attemptRef.current.key,
      });
      await queryClient.invalidateQueries({ queryKey: ["targets", selectedCompanyId] });
      reset();
      closeNewTarget();
      navigate(created.workbenchHref);
    } catch {
      // The mutation error is rendered below. The attempt key is retained so a
      // retry cannot duplicate a command whose outcome is temporarily unknown.
    }
  };

  const code = errorCode(createTarget.error);
  const errorMessage = code === "TARGET_IDEMPOTENCY_CONFLICT"
    ? t("targets.create.errors.conflict")
    : code === "TARGET_CREATE_FORBIDDEN"
      ? t("targets.create.errors.permission")
      : code === "TARGET_DOMAIN_API_UNAVAILABLE" || createTarget.error instanceof ApiError && createTarget.error.status === 503
        ? t("targets.create.errors.retryable")
        : createTarget.isError
          ? t("targets.create.errors.failed")
          : null;

  return (
    <Dialog
      open={newTargetOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewTarget();
        }
      }}
    >
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Target className="h-4 w-4" />
            {selectedCompany?.issuePrefix ? <span>{selectedCompany.issuePrefix}</span> : null}
          </div>
          <DialogTitle>{t("targets.create.title")}</DialogTitle>
          <DialogDescription>{t("targets.create.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          <div className="grid gap-2">
            <Label htmlFor="new-target-project">{t("targets.create.project")}</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="new-target-project" className="w-full">
                <SelectValue placeholder={t("targets.create.selectProject")} />
              </SelectTrigger>
              <SelectContent>
                {activeProjects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-target-title">{t("targets.create.name")}</Label>
            <Input id="new-target-title" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-target-summary">{t("targets.create.summary")}</Label>
            <Textarea id="new-target-summary" value={summary} maxLength={2000} onChange={(event) => setSummary(event.target.value)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="new-target-owner">{t("targets.create.owner")}</Label>
              <Select value={ownerValue} onValueChange={setOwnerValue}>
                <SelectTrigger id="new-target-owner" className="w-full">
                  <SelectValue placeholder={t("targets.create.selectOwner")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{t("targets.create.people")}</SelectLabel>
                    {(usersQuery.data?.users ?? []).map((entry) => (
                      <SelectItem key={entry.principalId} value={`user:${entry.principalId}`}>
                        {entry.user?.name ?? entry.user?.email ?? entry.principalId}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {activeAgents.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>{t("targets.create.agents")}</SelectLabel>
                      {activeAgents.map((agent) => (
                        <SelectItem key={agent.id} value={`agent:${agent.id}`}>{agent.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-target-risk">{t("targets.create.risk")}</Label>
              <Select value={riskLevel} onValueChange={(value) => setRiskLevel(value as CreateTargetInputV1["riskLevel"])}>
                <SelectTrigger id="new-target-risk" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["low", "medium", "high", "critical"] as const).map((risk) => (
                    <SelectItem key={risk} value={risk}>{t(`targets.risks.${risk}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-target-goal">{t("targets.create.goal")}</Label>
            <Textarea id="new-target-goal" value={goal} maxLength={4000} onChange={(event) => setGoal(event.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="new-target-constraints">{t("targets.create.constraints")}</Label>
            <Textarea id="new-target-constraints" value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder={t("targets.create.constraintsHint")} />
          </div>

          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium">{t("targets.create.acceptanceCriteria")}</legend>
            {criteria.map((criterion, index) => (
              <div key={criterion.key} className="grid gap-2 border-l border-border pl-3 sm:grid-cols-[1fr_1.5fr_auto]">
                <Input
                  aria-label={t("targets.create.criterionName", { index: index + 1 })}
                  value={criterion.title}
                  maxLength={200}
                  onChange={(event) => setCriteria((current) => current.map((item) => item.key === criterion.key ? { ...item, title: event.target.value } : item))}
                />
                <Input
                  aria-label={t("targets.create.criterionDescription", { index: index + 1 })}
                  value={criterion.description}
                  maxLength={2000}
                  onChange={(event) => setCriteria((current) => current.map((item) => item.key === criterion.key ? { ...item, description: event.target.value } : item))}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("targets.create.removeCriterion", { index: index + 1 })}
                  disabled={criteria.length === 1}
                  onClick={() => setCriteria((current) => current.filter((item) => item.key !== criterion.key))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="w-fit" disabled={criteria.length >= 20} onClick={() => setCriteria((current) => [...current, freshCriterion()])}>
              <Plus className="h-4 w-4" />
              {t("targets.create.addCriterion")}
            </Button>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="new-target-deadline">{t("targets.create.deadline")}</Label>
              <Input id="new-target-deadline" type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-target-policy">{t("targets.create.policy")}</Label>
              <Input id="new-target-policy" value={policySummary} maxLength={4000} onChange={(event) => setPolicySummary(event.target.value)} />
            </div>
          </div>

          {errorMessage ? (
            <div role="alert" className="flex items-start gap-2 border-y border-destructive/30 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { reset(); closeNewTarget(); }}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {createTarget.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            {createTarget.isPending ? t("targets.create.creating") : t("targets.create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
