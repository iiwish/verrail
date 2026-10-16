import { useRef, useState } from "react";
import { Plus, Save, Settings2, Trash2 } from "lucide-react";
import { criterionProofContractSchema, type CriterionProofContractV1, type CriterionProofRequirementV1, type TargetAcceptanceCriterionV1 } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";

export function CriterionProofEditor({ criterion, targetRevisionId, disabled, onSave }: {
  criterion: TargetAcceptanceCriterionV1;
  targetRevisionId: string;
  disabled: boolean;
  onSave: (contract: CriterionProofContractV1, expectedRevisionId: string, idempotencyKey: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [requirements, setRequirements] = useState<CriterionProofRequirementV1[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const envelope = useRef<{ payload: string; contract: CriterionProofContractV1; expectedRevisionId: string; idempotencyKey: string } | null>(null);
  const update = (index: number, requirement: CriterionProofRequirementV1) => setRequirements((items) => items.map((item, current) => current === index ? requirement : item));
  const save = async () => {
    const parsed = criterionProofContractSchema.safeParse({ schemaVersion: 1, allOf: requirements });
    if (!parsed.success) { setError(t("targets.criterionProof.invalid")); return; }
    setPending(true);
    setError(null);
    const payload = JSON.stringify(parsed.data);
    if (envelope.current?.payload !== payload) envelope.current = { payload, contract: parsed.data, expectedRevisionId: targetRevisionId, idempotencyKey: `target-proof-${crypto.randomUUID()}` };
    const attempt = envelope.current;
    try { await onSave(attempt.contract, attempt.expectedRevisionId, attempt.idempotencyKey); envelope.current = null; setOpen(false); } catch (cause) { setError(cause instanceof Error ? cause.message : t("targets.criterionProof.saveError")); }
    finally { setPending(false); }
  };
  return <Dialog open={open} onOpenChange={(value) => {
    if (pending) return;
    setOpen(value);
    if (value) { setRequirements(criterion.proofContract?.allOf ?? [{ id: "technical", kind: "independent_verification", phase: "pre_acceptance", assertions: [criterion.description ?? criterion.title] }]); setError(null); }
  }}>
    <DialogTrigger asChild><Button size="icon" variant="ghost" disabled={disabled} title={t("targets.criterionProof.revise")} aria-label={t("targets.criterionProof.revise")}><Settings2 className="h-4 w-4" /></Button></DialogTrigger>
    <DialogContent className="max-h-(--sz-calc-18) overflow-y-auto">
      <DialogHeader><DialogTitle>{t("targets.criterionProof.revise")}</DialogTitle></DialogHeader>
      <p className="text-sm font-medium">{criterion.title}</p>
      <p className="text-sm text-muted-foreground">{t("targets.criterionProof.revisionWarning")}</p>
      <div className="divide-y divide-border">
        {requirements.map((requirement, index) => <div key={requirement.id} className="space-y-2 py-3">
          <div className="flex items-center gap-2">
            <select aria-label={t("targets.criterionProof.kind")} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" value={requirement.kind} onChange={(event) => {
              const kind = event.target.value as CriterionProofRequirementV1["kind"];
              update(index, kind === "independent_verification" ? { id: requirement.id, kind, phase: "pre_acceptance", assertions: [criterion.description ?? criterion.title] } : kind === "human_governance" ? { id: requirement.id, kind, phase: "post_governance" } : { id: requirement.id, kind, phase: "post_effect" });
            }}>
              {(["independent_verification", "human_governance", "pull_request_effect"] as const).map((kind) => <option key={kind} value={kind}>{t(`targets.criterionProof.kinds.${kind}`)}</option>)}
            </select>
            <Button size="icon" variant="ghost" disabled={pending || requirements.length === 1} onClick={() => setRequirements((items) => items.filter((_, current) => current !== index))} aria-label={t("targets.criterionProof.remove")} title={t("targets.criterionProof.remove")}><Trash2 className="h-4 w-4" /></Button>
          </div>
          {requirement.kind === "independent_verification" ? <>
            <select aria-label={t("targets.criterionProof.phase")} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={requirement.phase} onChange={(event) => update(index, { ...requirement, phase: event.target.value as "pre_acceptance" | "post_effect" })}>
              <option value="pre_acceptance">{t("targets.criterionProof.phases.pre_acceptance")}</option><option value="post_effect">{t("targets.criterionProof.phases.post_effect")}</option>
            </select>
            <label className="block text-xs text-muted-foreground">{t("targets.criterionProof.assertions")}<textarea className="mt-1 min-h-24 w-full rounded-md border border-input bg-background p-3 text-sm text-foreground" value={requirement.assertions.join("\n")} onChange={(event) => update(index, { ...requirement, assertions: event.target.value.split("\n") })} /></label>
          </> : <p className="text-xs text-muted-foreground">{t(`targets.criterionProof.phases.${requirement.phase}`)}</p>}
        </div>)}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" disabled={pending || requirements.length >= 10} onClick={() => setRequirements((items) => [...items, { id: `proof-${crypto.randomUUID()}`, kind: "pull_request_effect", phase: "post_effect" }])}><Plus className="h-4 w-4" />{t("targets.criterionProof.add")}</Button>
        <Button disabled={pending} onClick={() => void save()}><Save className="h-4 w-4" />{t("targets.criterionProof.saveRevision")}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
