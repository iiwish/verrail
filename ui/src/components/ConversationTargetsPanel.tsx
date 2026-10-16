import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, ChevronDown, Link2, Plus, RotateCcw, Unlink } from "lucide-react";
import type { ConversationDetail, SwitchConversationContextInput } from "@paperclipai/shared";
import { conversationsApi } from "../api/conversations";
import { targetsApi } from "../api/targets";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { useTranslation } from "../i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function ConversationTargetProgress({ workspaceId, targetId }: { workspaceId: string; targetId: string }) {
  const { t, i18n } = useTranslation();
  const query = useQuery({ queryKey: ["targets", workspaceId, targetId, "conversation-progress"],
    queryFn: () => targetsApi.getWorkspace(workspaceId, targetId), refetchInterval: 15000 });
  if (query.isPending) return <p className="py-3 text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (query.isError) return <div role="alert" className="flex items-center gap-2 py-3 text-sm text-destructive">{t("chat.targets.progressFailed")}<Button variant="ghost" size="icon-sm" title={t("common.retry")} aria-label={t("common.retry")} onClick={() => void query.refetch()}><RotateCcw className="size-4" /></Button></div>;
  const data = query.data;
  return <div className="space-y-3 pb-3" data-testid="conversation-target-progress">
    <p className="text-sm font-medium">{t(`targets.outcomes.${data.outcome.state}`)}</p>
    <p className="text-xs text-muted-foreground">{t("chat.targets.nodeCount", { completed: data.work.filter(node => node.status === "completed").length, total: data.work.length })} · {t("chat.targets.updated", { time: new Date(data.generatedAt).toLocaleTimeString(i18n.resolvedLanguage) })}</p>
    {data.attention.length > 0 && <ul className="space-y-2 border-l-2 border-destructive pl-3">{data.attention.map(item => <li key={item.id} className="text-sm"><Link className="underline" to={`/targets/${targetId}/overview`}>{t(`targets.attentionKinds.${item.kind}`)}</Link>{item.detail && <p className="break-words text-xs text-muted-foreground">{item.detail}</p>}</li>)}</ul>}
    {data.work.length === 0 ? <p className="text-sm text-muted-foreground">{t("chat.targets.noNodes")}</p> : <ul className="divide-y divide-border">{data.work.map(node => <li key={node.id} className="py-2">
      <details><summary className="flex cursor-pointer items-center justify-between gap-3 text-sm"><span className="min-w-0 break-words">{node.title}</span><span className="shrink-0 text-xs text-muted-foreground">{t(`targets.graph.states.${node.status}`)}</span></summary>
        <div className="space-y-2 pt-2 text-xs text-muted-foreground">{node.completionDefinition && <p className="break-words">{node.completionDefinition}</p>}<Link className="underline" to={`/targets/${targetId}/overview`}>{t("chat.context.open")}</Link></div>
      </details>
    </li>)}</ul>}
    <Button asChild variant="outline" size="sm"><Link to={`/targets/${targetId}/delivery`}><ArrowUpRight className="size-4" />{t("chat.targets.delivery")}</Link></Button>
  </div>;
}

export function ConversationTargetsPanel({ conversation, onCreateTarget }: { conversation: ConversationDetail; onCreateTarget: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(conversation.currentTargetId ?? null);
  const [removal, setRemoval] = useState<{ id: string; version: number } | null>(null);
  const related = conversation.contextBindings.filter(binding => binding.contextType === "target");
  const mutation = useMutation({
    mutationFn: (input: SwitchConversationContextInput) => conversationsApi.switchContext(conversation.workspaceId, conversation.id, input),
    onSuccess: () => setRemoval(null),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.conversations.all(conversation.workspaceId) }),
  });
  const disabled = conversation.status === "archived" || mutation.isPending;
  const change = (targetId: string, operation?: "link" | "unlink") => mutation.mutate({ targetId, ...(operation ? { operation } : {}), expectedContextVersion: operation === "unlink" ? removal!.version : conversation.contextVersion ?? 0, idempotencyKey: crypto.randomUUID() });
  const targets = useInfiniteQuery({ queryKey: ["targets", "related-picker", conversation.workspaceId, search],
    queryFn: ({ pageParam }) => targetsApi.list(conversation.workspaceId, { q: search, archiveState: "all", limit: 25, cursor: pageParam }),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined, enabled: open && searching });
  const errorStatus = (mutation.error as { status?: number } | null)?.status;
  return <Dialog open={open} onOpenChange={value => { if (!mutation.isPending) { setOpen(value); setRemoval(null); mutation.reset(); } }}>
    <Button variant="ghost" size="sm" onClick={() => { setExpanded(conversation.currentTargetId ?? related[0]?.contextId ?? null); setOpen(true); }}><Link2 className="size-4" />{t("chat.targets.related", { count: related.length })}</Button>
    <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{t("chat.targets.title")}</DialogTitle><DialogDescription>{t("chat.targets.description")}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={() => setSearching(!searching)}><Link2 className="size-4" />{t("chat.targets.link")}</Button><Button size="sm" disabled={disabled} onClick={() => { setOpen(false); onCreateTarget(); }}><Plus className="size-4" />{t("targets.create.title")}</Button></div>
      {mutation.isError && <div role="alert" className="text-sm text-destructive">{t(errorStatus === 409 ? "chat.context.conflict" : errorStatus === 403 ? "chat.context.forbidden" : errorStatus === 404 ? "chat.context.unavailable" : "chat.context.failed")}{!errorStatus || errorStatus >= 500 ? <Button variant="ghost" size="sm" onClick={() => mutation.variables && mutation.mutate(mutation.variables)}>{t("common.retry")}</Button> : null}</div>}
      {searching && <section className="space-y-2 border-b pb-3"><Input aria-label={t("chat.context.search")} placeholder={t("chat.context.search")} value={search} maxLength={200} onChange={event => setSearch(event.target.value)} />
        {targets.isPending && <p className="text-sm">{t("common.loading")}</p>}
        {targets.isError && <div role="alert" className="text-sm text-destructive">{t("chat.context.loadFailed")}<Button variant="ghost" size="sm" onClick={() => void targets.refetch()}>{t("common.retry")}</Button></div>}
        {targets.data?.pages.flatMap(page => page.items).map(target => <div key={target.targetId} className="flex items-center gap-2 text-sm"><span className="min-w-0 flex-1 break-words">{target.title}</span><Button variant="ghost" size="icon-sm" disabled={disabled || related.some(binding => binding.contextId === target.targetId)} title={t("chat.targets.link")} aria-label={`${t("chat.targets.link")} ${target.title}`} onClick={() => change(target.targetId, "link")}>{related.some(binding => binding.contextId === target.targetId) ? <Check className="size-4" /> : <Plus className="size-4" />}</Button></div>)}
        {targets.data?.pages[0]?.items.length === 0 && <p className="text-sm text-muted-foreground">{t("chat.context.empty")}</p>}
        {targets.hasNextPage && <Button variant="ghost" size="sm" disabled={targets.isFetchingNextPage} onClick={() => void targets.fetchNextPage()}>{t("chat.context.more")}</Button>}
      </section>}
      {related.length === 0 && <p className="text-sm text-muted-foreground">{t("chat.targets.empty")}</p>}
      <ul className="divide-y divide-border">{related.map(binding => <li key={binding.id} className="space-y-2 py-3">
        <div className="flex flex-wrap items-center gap-2"><Button className="min-w-0 flex-1 justify-start" variant="ghost" size="sm" aria-expanded={expanded === binding.contextId} onClick={() => setExpanded(expanded === binding.contextId ? null : binding.contextId)}><ChevronDown className="size-4 shrink-0" /><span className="truncate">{binding.label ?? binding.contextId}</span></Button>
          {conversation.currentTargetId === binding.contextId ? <span className="text-xs text-muted-foreground">{t("chat.context.current")}</span> : <Button variant="ghost" size="sm" disabled={disabled} onClick={() => change(binding.contextId)}>{t("chat.targets.focus")}</Button>}
          <Button variant="ghost" size="icon-sm" disabled={disabled} title={t("chat.targets.unlink")} aria-label={`${t("chat.targets.unlink")} ${binding.label ?? binding.contextId}`} onClick={() => setRemoval({ id: binding.contextId, version: conversation.contextVersion ?? 0 })}><Unlink className="size-4" /></Button>
          <Button asChild variant="ghost" size="icon-sm" title={t("chat.context.open")} aria-label={`${t("chat.context.open")} ${binding.label ?? binding.contextId}`}><Link to={`/targets/${binding.contextId}/overview`}><ArrowUpRight className="size-4" /></Link></Button>
        </div>
        {removal?.id === binding.contextId && <div className="space-y-2 border-l-2 border-border pl-3"><p className="text-sm">{t("chat.targets.unlinkConfirm")}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => setRemoval(null)}>{t("common.cancel")}</Button><Button size="sm" disabled={disabled} onClick={() => change(binding.contextId, "unlink")}>{t("common.confirm")}</Button></div></div>}
        {open && expanded === binding.contextId && <ConversationTargetProgress workspaceId={conversation.workspaceId} targetId={binding.contextId} />}
      </li>)}</ul>
    </DialogContent>
  </Dialog>;
}
