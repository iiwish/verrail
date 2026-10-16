import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { agentLifecycleApi } from "@/api/agentLifecycle";
import { queryKeys } from "@/lib/queryKeys";
import { samePublicationValue } from "@/lib/agent-publication";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function AgentPublicationButton({ agent, disabled }: { agent: Agent; disabled: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const key = useRef(crypto.randomUUID());
  const lifecycle = useQuery({ queryKey: queryKeys.agentLifecycle(agent.companyId), queryFn: () => agentLifecycleApi.get(agent.companyId) });
  const preview = useQuery({ queryKey: ["agent-publication", agent.companyId, agent.id], queryFn: () => agentLifecycleApi.preview(agent.companyId, agent.id), enabled: open, staleTime: 0 });
  const definitions = lifecycle.data?.definitions.filter((item) => item.compatibilityAgentId === agent.id) ?? [];
  const definition = definitions[0];
  const latest = definition?.versions.at(-1);
  const publish = useMutation({
    mutationFn: async () => {
      if (!preview.data || definitions.length > 1 || lifecycle.isError) throw new Error(t("agentPublication.unavailable"));
      const id = definition?.id ?? (await agentLifecycleApi.createDefinition(agent.companyId, { name: agent.name, compatibilityAgentId: agent.id }, `${key.current}.definition`)).resourceId;
      return agentLifecycleApi.publishSaved(agent.companyId, id, preview.data.sourceHash, `${key.current}.version`);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.agentLifecycle(agent.companyId) });
      setOpen(false);
    },
  });
  const fields = ["runtime", "model", "prompt", "skills", "tools", "supplyChain"] as const;
  const changed = preview.data ? fields.filter((field) => !samePublicationValue(preview.data.snapshot[field], latest?.[field])) : [];
  const error = publish.error ?? preview.error ?? lifecycle.error;
  return <>
    <Button size="sm" variant="outline" disabled={disabled} title={disabled ? t("agentPublication.saveFirst") : t("agentLifecycle.publish")} onClick={() => { key.current = crypto.randomUUID(); publish.reset(); setOpen(true); }}><Upload className="size-4" />{t("agentLifecycle.publish")}{latest ? ` · v${latest.versionNumber}` : ""}</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!publish.isPending) setOpen(value); }}>
      <DialogContent className="max-h-screen overflow-y-auto">
        <DialogHeader><DialogTitle>{t("agentPublication.title")}</DialogTitle><DialogDescription>{t("agentPublication.description")}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error instanceof Error ? error.message : t("agentPublication.unavailable")}</p>}
        {definitions.length > 1 && <p role="alert" className="text-sm text-destructive">{t("agentPublication.ambiguous")}</p>}
        {preview.isFetching ? <p className="text-sm text-muted-foreground">{t("common.loading")}</p> : preview.data && <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-3"><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.runtime")}</dt><dd>{preview.data.snapshot.runtime}</dd></div><div><dt className="text-muted-foreground">{t("agentLifecycle.publishFields.model")}</dt><dd className="break-words">{preview.data.snapshot.model}</dd></div></dl>
          <p>{latest ? t("agentPublication.compared", { version: latest.versionNumber, fields: changed.map((field) => t(`agentPublication.fields.${field}`)).join(" / ") || t("agentPublication.noChanges") }) : t("agentPublication.firstVersion")}</p>
          <details><summary className="cursor-pointer font-medium">{t("agentLifecycle.publishFields.prompt")}</summary><pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans text-sm">{preview.data.snapshot.prompt}</pre></details>
          <details><summary className="cursor-pointer font-medium">{t("agentPublication.snapshot")}</summary><pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{JSON.stringify(preview.data.snapshot, null, 2)}</pre></details>
          <p className="text-muted-foreground">{t(preview.data.mode === "director_chat" ? "agentPublication.directorBoundary" : "agentPublication.executorBoundary")}</p>
          <p className="text-muted-foreground">{t("agentPublication.exclusions")}</p>
          {preview.data.warnings.map((warning) => <p key={warning} className="break-words text-destructive">{warning}</p>)}
        </div>}
        <DialogFooter><Button variant="outline" disabled={publish.isPending} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>{error && <Button variant="outline" onClick={() => { publish.reset(); void preview.refetch(); void lifecycle.refetch(); }}>{t("common.retry")}</Button>}<Button disabled={disabled || publish.isPending || preview.isFetching || !preview.data || preview.isError || lifecycle.isLoading || lifecycle.isError || definitions.length > 1 || changed.length === 0} onClick={() => publish.mutate()}>{publish.isPending ? t("common.saving") : t("agentPublication.confirm")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
