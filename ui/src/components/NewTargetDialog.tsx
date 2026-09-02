import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateTargetInputV1, TargetCreationDraft } from "@paperclipai/shared";
import { AlertCircle, LoaderCircle, Plus, Target, X } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { collectionsApi } from "../api/collections";
import { conversationsApi } from "../api/conversations";
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
const NO_COLLECTION = "__no_collection__";

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
  const [draft, setDraft] = useState<TargetCreationDraft | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [ownerValue, setOwnerValue] = useState("");
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [criteria, setCriteria] = useState<CriterionDraft[]>(() => [freshCriterion()]);
  const [riskLevel, setRiskLevel] = useState<CreateTargetInputV1["riskLevel"]>("medium");
  const [deadline, setDeadline] = useState("");
  const [policySummary, setPolicySummary] = useState("");

  const collectionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.collections.list(selectedCompanyId) : ["collections", "disabled"],
    queryFn: () => collectionsApi.list(selectedCompanyId!),
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

  const collections = collectionsQuery.data ?? [];
  const activeAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated"),
    [agentsQuery.data],
  );

  useEffect(() => {
    if (!newTargetOpen || collectionId) return;
    const preferred = newTargetDefaults.collectionId;
    if (preferred && collections.some((collection) => collection.id === preferred)) {
      setCollectionId(preferred);
    }
  }, [collectionId, collections, newTargetDefaults.collectionId, newTargetOpen]);

  useEffect(() => {
    if (!newTargetOpen || ownerValue) return;
    const user = usersQuery.data?.users[0];
    if (user) setOwnerValue(`user:${user.principalId}`);
  }, [newTargetOpen, ownerValue, usersQuery.data?.users]);

  const createDraft = useMutation({
    mutationFn: async (input: CreateTargetInputV1) => {
      const conversationId = newTargetDefaults.conversationId
        ?? (await conversationsApi.create(selectedCompanyId!, { title: input.title, contextBindings: [] })).id;
      const source = await conversationsApi.appendStructuredMessage(
        selectedCompanyId!,
        conversationId,
        `Create Target: ${input.title}`,
      );
      return conversationsApi.createTargetDraft(selectedCompanyId!, conversationId, source.id, {
        collectionId: input.collectionId ?? null,
        title: input.title,
        summary: input.summary ?? null,
        outcomeOwner: input.outcomeOwner,
        goal: input.goal,
        constraints: input.constraints,
        acceptanceCriteria: input.acceptanceCriteria,
        riskLevel: input.riskLevel,
        deadline: input.deadline ?? null,
        policySummary: input.policySummary ?? null,
        resourceRefs: input.resourceRefs ?? [],
      });
    },
  });
  const confirmDraft = useMutation({
    mutationFn: (current: TargetCreationDraft) => conversationsApi.confirmTargetDraft(
      selectedCompanyId!,
      current.conversationId,
      current.id,
      current.activeRevisionNumber,
    ),
  });

  const reset = () => {
    setCollectionId("");
    setTitle("");
    setSummary("");
    setOwnerValue("");
    setGoal("");
    setConstraints("");
    setCriteria([freshCriterion()]);
    setRiskLevel("medium");
    setDeadline("");
    setPolicySummary("");
    setDraft(null);
    createDraft.reset();
    confirmDraft.reset();
  };

  const validCriteria = criteria.filter((criterion) => criterion.title.trim());
  const canSubmit = Boolean(
    selectedCompanyId
    && title.trim()
    && ownerValue
    && goal.trim()
    && validCriteria.length === criteria.length
    && criteria.length > 0
    && !createDraft.isPending
    && !confirmDraft.isPending,
  );

  const submit = async () => {
    if (!canSubmit || !selectedCompanyId) return;
    const separator = ownerValue.indexOf(":");
    const principalType = ownerValue.slice(0, separator) as "user" | "agent";
    const principalId = ownerValue.slice(separator + 1);
    const input: CreateTargetInputV1 = {
      ...(collectionId ? { collectionId } : {}),
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
    try {
      if (!draft) {
        setDraft(await createDraft.mutateAsync(input));
        return;
      }
      const created = (await confirmDraft.mutateAsync(draft)).target;
      await queryClient.invalidateQueries({ queryKey: ["targets", selectedCompanyId] });
      reset();
      closeNewTarget();
      navigate(created.workbenchHref);
    } catch {
      // Mutation errors are rendered below. Confirmation retries reuse the
      // server-owned Draft revision idempotency key.
    }
  };

  const mutationError = confirmDraft.error ?? createDraft.error;
  const code = errorCode(mutationError);
  const errorMessage = code === "TARGET_IDEMPOTENCY_CONFLICT"
    ? t("targets.create.errors.conflict")
    : code === "TARGET_CREATE_FORBIDDEN"
      ? t("targets.create.errors.permission")
      : code === "TARGET_DOMAIN_API_UNAVAILABLE" || mutationError instanceof ApiError && mutationError.status === 503
        ? t("targets.create.errors.retryable")
        : createDraft.isError || confirmDraft.isError
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

        <fieldset disabled={Boolean(draft)} className="grid gap-5 border-0 p-0 py-2">
          {collections.length > 0 ? (
            <div className="grid gap-2">
              <Label htmlFor="new-target-collection">{t("targets.create.collection")}</Label>
              <Select
                value={collectionId || NO_COLLECTION}
                onValueChange={(value) => setCollectionId(value === NO_COLLECTION ? "" : value)}
              >
                <SelectTrigger id="new-target-collection" className="w-full">
                  <SelectValue placeholder={t("targets.create.selectCollection")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_COLLECTION}>{t("targets.create.noCollection")}</SelectItem>
                  {collections.map((collection) => (
                    <SelectItem key={collection.id} value={collection.id}>{collection.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

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
        </fieldset>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { reset(); closeNewTarget(); }}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {createDraft.isPending || confirmDraft.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            {createDraft.isPending || confirmDraft.isPending
              ? t("targets.create.creating")
              : draft ? t("targets.create.confirm") : t("targets.create.review")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
