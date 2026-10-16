import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowUpRight, Check, ChevronsUpDown, RotateCcw, Target, X } from "lucide-react";
import type { ConversationDetail, ConversationMessage, SwitchConversationContextInput } from "@paperclipai/shared";
import { conversationsApi } from "../api/conversations";
import { targetsApi } from "../api/targets";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { useTranslation } from "../i18n";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Command, CommandInput, CommandItem, CommandList, CommandSeparator } from "./ui/command";

function useContextMutation(conversation: ConversationDetail) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SwitchConversationContextInput) => conversationsApi.switchContext(conversation.workspaceId, conversation.id, input),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.conversations.all(conversation.workspaceId) });
    },
  });
}

function ContextError({ mutation }: { mutation: ReturnType<typeof useContextMutation> }) {
  const { t } = useTranslation();
  if (!mutation.isError) return null;
  const status = (mutation.error as { status?: number }).status;
  return <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
    {t(status === 409 ? "chat.context.conflict" : status === 403 ? "chat.context.forbidden" : status === 404 ? "chat.context.unavailable" : "chat.context.failed")}
    {!status || status >= 500 ? <Button size="icon-sm" variant="ghost" title={t("common.retry")} aria-label={t("common.retry")} onClick={() => mutation.variables && mutation.mutate(mutation.variables)}><RotateCcw className="h-4 w-4" /></Button> : null}
  </div>;
}

export function ConversationTargetContext({ conversation }: { conversation: ConversationDetail }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const mutation = useContextMutation(conversation);
  const targets = useInfiniteQuery({
    queryKey: ["targets", "context-picker", conversation.workspaceId, search],
    queryFn: ({ pageParam }) => targetsApi.list(conversation.workspaceId, { q: search, archiveState: "all", limit: 25, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: open,
  });
  const select = (targetId: string | null) => mutation.mutate({ targetId, expectedContextVersion: conversation.contextVersion ?? 0, idempotencyKey: crypto.randomUUID() }, { onSuccess: () => setOpen(false) });
  const disabled = conversation.status === "archived" || mutation.isPending;
  return <div className="min-w-0 max-w-full space-y-2">
    <div className="flex min-w-0 items-center gap-1 text-xs">
      <span className="sr-only">{t("chat.context.current")}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild><Button variant="ghost" size="sm" className="min-w-0 max-w-48" disabled={disabled} aria-label={t("chat.context.select")} title={conversation.currentTarget?.title ?? t("chat.context.select")}>
          <Target className="h-4 w-4 shrink-0" /><span className="truncate">{conversation.currentTarget?.title ?? t(conversation.currentTargetId ? "chat.context.unavailable" : "chat.workspaceContext")}</span><ChevronsUpDown className="h-3.5 w-3.5 shrink-0" />
        </Button></PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-full p-0">
          <Command shouldFilter={false}><CommandInput placeholder={t("chat.context.search")} value={search} onValueChange={setSearch} maxLength={200} /><CommandList>
            {targets.isLoading ? <p className="p-3 text-sm text-muted-foreground">{t("common.loading")}</p> : null}
            {targets.isError ? <div role="alert" className="p-3 text-sm text-destructive">{t("chat.context.loadFailed")}<Button variant="ghost" size="icon-sm" title={t("common.retry")} aria-label={t("common.retry")} onClick={() => void targets.refetch()}><RotateCcw className="h-4 w-4" /></Button></div> : null}
            {targets.data?.pages.flatMap(page => page.items).map(target => <CommandItem key={target.targetId} value={target.targetId} disabled={disabled || target.targetId === conversation.currentTargetId} onSelect={() => select(target.targetId)}>
              <Target /><span className="min-w-0 flex-1 break-words">{target.title}</span>{target.archivedAt ? <Archive aria-label={t("targets.list.archived")} /> : null}{target.targetId === conversation.currentTargetId ? <Check /> : null}
            </CommandItem>)}
            {!targets.isLoading && !targets.isError && targets.data?.pages[0]?.items.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{t("chat.context.empty")}</p> : null}
            {targets.hasNextPage ? <Button variant="ghost" size="sm" disabled={targets.isFetchingNextPage} onClick={() => void targets.fetchNextPage()}>{t("chat.context.more")}</Button> : null}
            {conversation.currentTargetId ? <><CommandSeparator /><CommandItem value="clear-current-target" disabled={disabled} onSelect={() => select(null)}><X /><span>{t("chat.context.clear")}</span></CommandItem></> : null}
          </CommandList></Command>
        </PopoverContent>
      </Popover>
      {conversation.currentTarget?.archivedAt ? <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("targets.list.archived")} /> : null}
      {conversation.currentTarget ? <Button asChild variant="ghost" size="icon-sm" title={t("chat.context.open")} aria-label={t("chat.context.open")}><Link to={`/targets/${conversation.currentTarget.targetId}/overview`}><ArrowUpRight className="h-4 w-4" /></Link></Button> : null}
    </div>
    <ContextError mutation={mutation} />
  </div>;
}

export function ConversationContextChange({ conversation, message }: { conversation: ConversationDetail; message: ConversationMessage }) {
  const { t } = useTranslation();
  const mutation = useContextMutation(conversation);
  const data = message.metadata!;
  const canUndo = !data.operation && conversation.status === "active" && data.contextVersion === conversation.contextVersion && data.currentTargetId === conversation.currentTargetId;
  return <div className="space-y-1"><div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status"><Target className="h-3.5 w-3.5" />{t(data.operation === "link" ? "chat.targets.linked" : data.operation === "unlink" ? "chat.targets.unlinked" : data.currentTargetId ? "chat.context.switched" : "chat.context.cleared", { title: String(data.targetTitle ?? "") })}
    {canUndo ? <Button variant="ghost" size="icon-sm" disabled={mutation.isPending} title={t("chat.context.undo")} aria-label={t("chat.context.undo")} onClick={() => mutation.mutate({ targetId: typeof data.previousTargetId === "string" ? data.previousTargetId : null, expectedContextVersion: conversation.contextVersion ?? 0, idempotencyKey: crypto.randomUUID() })}><RotateCcw className="h-4 w-4" /></Button> : null}
  </div><ContextError mutation={mutation} /></div>;
}

export function FocusCreatedTarget({ conversation, targetId }: { conversation: ConversationDetail; targetId: string }) {
  const { t } = useTranslation();
  const mutation = useContextMutation(conversation);
  if (conversation.currentTargetId === targetId) return null;
  return <div><Button variant="ghost" size="sm" disabled={conversation.status === "archived" || mutation.isPending} onClick={() => mutation.mutate({ targetId, expectedContextVersion: conversation.contextVersion ?? 0, idempotencyKey: crypto.randomUUID() })}><Target className="h-4 w-4" />{t("chat.context.continue")}</Button><ContextError mutation={mutation} /></div>;
}
