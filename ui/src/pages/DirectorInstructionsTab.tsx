import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, RotateCcw, Check, RefreshCw, ShieldCheck, Copy } from "lucide-react";
import type { DirectorInstructionsView } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { CopyText } from "@/components/CopyText";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { buildLineDiff } from "@/lib/line-diff";
import { queryKeys } from "@/lib/queryKeys";

type Draft = { rolePrompt: string; base: DirectorInstructionsView };

export function DirectorInstructionsTab({ agentId, companyId, onDirtyChange }: {
  agentId: string;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [candidate, setCandidate] = useState<Draft | null>(null);
  const [view, setView] = useState("role");
  const [applied, setApplied] = useState(false);
  const queryKey = queryKeys.agents.directorInstructions(agentId, companyId);
  const query = useQuery({ queryKey, queryFn: () => agentsApi.directorInstructions(agentId, companyId), enabled: Boolean(companyId) });
  const preview = useMutation({ mutationFn: (rolePrompt: string) => agentsApi.previewDirectorInstructions(agentId, rolePrompt, companyId) });
  const apply = useMutation({
    mutationFn: (input: Draft) => agentsApi.applyDirectorInstructions(agentId, {
      rolePrompt: input.rolePrompt, expectedConfigHash: input.base.configHash,
    }, companyId),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      setCandidate(null);
      setDraft(null);
      preview.reset();
      setApplied(true);
    },
  });
  const active = query.data;
  const content = draft?.rolePrompt ?? active?.rolePrompt ?? "";
  const dirty = Boolean(draft && draft.rolePrompt.trim() !== draft.base.rolePrompt);
  const valid = content.trim().length > 0 && content.trim().length <= 24_000;
  const conflict = Boolean(draft && active && draft.base.configHash !== active.configHash);
  const effective = preview.data?.rolePrompt === content.trim() ? preview.data : !dirty ? active : undefined;
  const diff = useMemo(() => {
    if (!candidate) return [];
    // Bound the existing LCS helper for unusually line-dense custom instructions.
    if (candidate.base.rolePrompt.split("\n").length > 400 || candidate.rolePrompt.split("\n").length > 400) return null;
    return buildLineDiff(candidate.base.rolePrompt, candidate.rolePrompt);
  }, [candidate]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const error = apply.error ?? preview.error;
  const errorText = error instanceof ApiError && error.status === 409
    ? t("directorBehavior.conflict")
    : error instanceof ApiError && error.status === 403
      ? t("directorBehavior.forbidden") : t("directorBehavior.commandFailed");

  if (query.isPending) return <p className="text-sm text-muted-foreground" role="status">{t("common.loading")}</p>;
  if (!active || query.isError) return (
    <div className="flex items-center gap-3">
      <p className="text-sm text-destructive" role="alert">{t("directorBehavior.loadFailed")}</p>
      <Button variant="outline" onClick={() => void query.refetch()}><RefreshCw className="size-4" />{t("common.retry")}</Button>
    </div>
  );

  function edit(rolePrompt: string) {
    setDraft((current) => ({ rolePrompt, base: current?.base ?? active! }));
    setApplied(false);
    apply.reset();
  }

  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="director-behavior">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-base font-semibold">{t("directorBehavior.identity")}</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t(active.mode === "execution_gateway" ? "directorBehavior.gateway" : "directorBehavior.compatibility")}</span>
            <span>{active.runtime === "opencode" ? "OpenCode" : active.runtime === "codex" ? "Codex" : "Claude"}</span>
            <span>{active.revision === 0 ? t("directorBehavior.builtin") : t("directorBehavior.revision", { revision: active.revision })}</span>
            {dirty && <span className="text-foreground">{t("directorBehavior.draft")}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!valid || preview.isPending} onClick={() => { preview.mutate(content.trim()); setView("effective"); }}>
            <Eye className="size-4" />{t("directorBehavior.preview")}
          </Button>
          <Button disabled={!dirty || !valid || conflict || apply.isPending} onClick={() => setCandidate({ rolePrompt: content.trim(), base: draft!.base })}>
            <Check className="size-4" />{t("directorBehavior.apply")}
          </Button>
        </div>
      </div>
      {!active.available && <p className="text-sm text-muted-foreground" role="status">{t("directorBehavior.unavailable")}</p>}
      {(conflict || error) && <p className="text-sm text-destructive" role="alert">{conflict ? t("directorBehavior.conflict") : errorText}</p>}
      {applied && <p className="text-sm" role="status">{t("directorBehavior.applied")}</p>}
      <Tabs value={view} onValueChange={setView}>
        <PageTabBar items={[
          { value: "role", label: t("directorBehavior.role") },
          { value: "effective", label: t("directorBehavior.effective") },
          { value: "rules", label: t("directorBehavior.rules") },
        ]} value={view} onValueChange={setView} align="start" />
      </Tabs>
      {view === "role" && <div className="flex min-w-0 flex-col gap-3">
        <label htmlFor="director-role-prompt" className="text-sm font-medium">{t("directorBehavior.role")}</label>
        <Textarea id="director-role-prompt" value={content} maxLength={24_000} onChange={(event) => edit(event.target.value)}
          className="h-96 resize-y font-mono text-sm leading-relaxed" spellCheck={false} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("directorBehavior.characters", { count: content.length })}</span>
          <div className="flex flex-wrap items-center gap-2">
            {draft && <Button variant="ghost" onClick={() => { setDraft(null); preview.reset(); apply.reset(); void query.refetch(); }}>
              <RotateCcw className="size-4" />{t("directorBehavior.discard")}
            </Button>}
            <Button variant="ghost" disabled={content === active.defaultPrompt} onClick={() => edit(active.defaultPrompt)}>
              <RotateCcw className="size-4" />{t("directorBehavior.useDefault")}
            </Button>
          </div>
        </div>
      </div>}
      {view === "effective" && <div className="flex min-w-0 flex-col gap-3">
        {preview.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("common.loading")}</p> : effective ? <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{effective.preview ? t("directorBehavior.previewOnly") : t("directorBehavior.activePrompt")}</span>
            <CopyText text={effective.systemPrompt} ariaLabel={t("directorBehavior.copyPrompt")} title={t("directorBehavior.copyPrompt")} copiedLabel={t("directorBehavior.copied")} className="grid size-8 place-items-center rounded-md border border-border">
              <Copy className="size-4" />
            </CopyText>
          </div>
          <code className="break-all text-xs text-muted-foreground">SHA-256 {effective.effectiveHash}</code>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-4 font-mono text-xs leading-relaxed">{effective.systemPrompt}</pre>
        </> : <p className="text-sm text-muted-foreground">{t("directorBehavior.previewStale")}</p>}
      </div>}
      {view === "rules" && <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />{t("directorBehavior.platform")} <code className="text-xs text-muted-foreground">{active.policyVersion}</code></div>
        <MarkdownBody>{active.platformRules}</MarkdownBody>
        <h4 className="text-sm font-medium">{t("directorBehavior.runtimeCapabilities")}</h4>
        <MarkdownBody>{active.toolRules}</MarkdownBody>
      </div>}
      <Dialog open={Boolean(candidate)} onOpenChange={(open) => { if (!open && !apply.isPending) setCandidate(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("directorBehavior.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("directorBehavior.confirmScope")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-auto rounded-md border border-border p-3 font-mono text-xs leading-relaxed">
            {diff ? diff.map((row, index) => <div key={index} className={row.kind === "removed" ? "whitespace-pre-wrap break-words text-destructive" : row.kind === "added" ? "whitespace-pre-wrap break-words bg-accent" : "whitespace-pre-wrap break-words text-muted-foreground"}>
              {row.kind === "added" ? "+ " : row.kind === "removed" ? "- " : "  "}{row.text}
            </div>) : <pre className="whitespace-pre-wrap break-words">{candidate?.rolePrompt}</pre>}
          </div>
          {apply.error && <p role="alert" className="text-sm text-destructive">{errorText}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={apply.isPending} onClick={() => setCandidate(null)}>{t("common.cancel")}</Button>
            <Button disabled={apply.isPending || !candidate} onClick={() => candidate && apply.mutate(candidate)}><Check className="size-4" />{t("directorBehavior.confirmApply")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
