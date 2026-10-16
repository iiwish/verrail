import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, MessagesSquare, RotateCcw } from "lucide-react";
import { conversationsApi } from "../../api/conversations";
import { useTranslation } from "../../i18n";
import { Link } from "../../lib/router";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export function TargetConversations({ workspaceId, targetId }: { workspaceId: string; targetId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const active = useQuery({ queryKey: ["conversations", workspaceId, "target", targetId, "active"], queryFn: () => conversationsApi.list(workspaceId, { targetId, status: "active" }), enabled: open });
  const archived = useQuery({ queryKey: ["conversations", workspaceId, "target", targetId, "archived"], queryFn: () => conversationsApi.list(workspaceId, { targetId, status: "archived" }), enabled: open });
  const rows = [...(active.data ?? []), ...(archived.data ?? [])];
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline" size="sm"><MessagesSquare className="h-4 w-4" />{t("chat.context.conversations")}</Button></PopoverTrigger>
    <PopoverContent align="end" className="max-h-80 overflow-y-auto p-2">
      {active.isLoading || archived.isLoading ? <p className="p-2 text-sm text-muted-foreground">{t("common.loading")}</p> : null}
      {active.isError || archived.isError ? <div role="alert" className="p-2 text-sm text-destructive">{t("chat.context.loadFailed")}<Button variant="ghost" size="icon-sm" title={t("common.retry")} aria-label={t("common.retry")} onClick={() => { void active.refetch(); void archived.refetch(); }}><RotateCcw className="h-4 w-4" /></Button></div> : null}
      {rows.map(row => <Link key={row.id} to={`/chat/${row.id}`} className="flex items-center gap-2 rounded-sm p-2 text-sm hover:bg-accent" onClick={() => setOpen(false)}><span className="min-w-0 flex-1 break-words">{row.title}</span>{row.targetRelation === "source" ? <span className="shrink-0 text-xs text-muted-foreground">{t("chat.targets.source")}</span> : null}{row.status === "archived" ? <Archive className="h-4 w-4 shrink-0" aria-label={t("targets.list.archived")} /> : null}</Link>)}
      {!active.isLoading && !archived.isLoading && !active.isError && !archived.isError && rows.length === 0 ? <p className="p-2 text-sm text-muted-foreground">{t("chat.context.noConversations")}</p> : null}
    </PopoverContent>
  </Popover>;
}
