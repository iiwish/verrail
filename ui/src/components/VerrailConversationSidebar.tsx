import { useDeferredValue, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
} from "lucide-react";
import type { Conversation } from "@paperclipai/shared";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { conversationsApi } from "../api/conversations";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { useTranslation } from "@/i18n";

function ConversationRow({
  conversation,
  active,
  onRename,
  onTogglePin,
  onToggleArchive,
}: {
  conversation: Conversation;
  active: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
}) {
  const { t } = useTranslation();
  const { isMobile, setSidebarOpen } = useSidebar();
  const title = conversation.title === "New conversation" ? t("chat.new") : conversation.title;
  return (
    <div
      className={cn(
        "group mx-2 flex min-w-0 items-center rounded-md transition-colors",
        active ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <Link
        to={`/chat/${conversation.id}`}
        onClick={() => { if (isMobile) setSidebarOpen(false); }}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2"
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="mt-0.5 block truncate text-(length:--text-micro) text-muted-foreground">
            {relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}
          </span>
        </span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            aria-label={t("chat.actions")}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil className="h-4 w-4" />
            {t("chat.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onTogglePin}>
            {conversation.pinnedAt ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            {conversation.pinnedAt ? t("chat.unpin") : t("chat.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleArchive}>
            {conversation.status === "archived" ? (
              <ArchiveRestore className="h-4 w-4" />
            ) : (
              <Archive className="h-4 w-4" />
            )}
            {conversation.status === "archived" ? t("chat.restore") : t("chat.archive")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function VerrailConversationSidebar() {
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const status = showArchived ? "archived" : "active";

  const conversationsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.conversations.list(selectedCompanyId, status, deferredSearch)
      : ["conversations", "disabled"],
    queryFn: () => conversationsApi.list(selectedCompanyId!, { status, q: deferredSearch || undefined }),
    enabled: Boolean(selectedCompanyId),
  });
  const createMutation = useMutation({
    mutationFn: () => conversationsApi.create(selectedCompanyId!),
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(selectedCompanyId!) });
      navigate(`/chat/${conversation.id}`);
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof conversationsApi.update>[2] }) =>
      conversationsApi.update(selectedCompanyId!, id, patch),
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(selectedCompanyId!, conversation.id) });
      setRenaming(null);
      if (conversation.status === "archived" && conversation.id === conversationId) navigate("/chat");
    },
  });

  const conversations = conversationsQuery.data ?? [];
  const pinned = useMemo(() => conversations.filter((item) => item.pinnedAt), [conversations]);
  const recent = useMemo(() => conversations.filter((item) => !item.pinnedAt), [conversations]);

  const renderRows = (rows: Conversation[]) => rows.map((conversation) => (
    <ConversationRow
      key={conversation.id}
      conversation={conversation}
      active={conversation.id === conversationId}
      onRename={() => {
        setRenaming(conversation);
        setRenameValue(conversation.title === "New conversation" ? "" : conversation.title);
      }}
      onTogglePin={() => updateMutation.mutate({ id: conversation.id, patch: { pinned: !conversation.pinnedAt } })}
      onToggleArchive={() => updateMutation.mutate({
        id: conversation.id,
        patch: { status: conversation.status === "archived" ? "active" : "archived" },
      })}
    />
  ));

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background" data-testid="verrail-chat-sidebar">
      <div className="shrink-0 space-y-2 px-3 py-3">
        <Link
          to="/home"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedCompany?.name ?? t("settings.company.fallbackName")}</span>
        </Link>
        <div className="flex items-center justify-between gap-2 px-2">
          <Link to="/chat" className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{t("nav.chat")}</span>
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => createMutation.mutate()}
            disabled={!selectedCompanyId || createMutation.isPending}
            aria-label={t("chat.new")}
            title={t("chat.new")}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("chat.search")}
            aria-label={t("chat.search")}
            className="h-8 pl-8 text-xs"
          />
        </div>
        {createMutation.error || updateMutation.error ? (
          <p role="alert" className="px-2 text-xs text-destructive">{t("chat.actionFailed")}</p>
        ) : null}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto pb-3 scrollbar-auto-hide" aria-label={t("nav.chat")}>
        {conversationsQuery.isLoading ? (
          <p className="px-5 py-4 text-xs text-muted-foreground">{t("chat.loading")}</p>
        ) : conversationsQuery.error ? (
          <p className="px-5 py-4 text-xs text-destructive">{t("chat.listUnavailable")}</p>
        ) : conversations.length === 0 ? (
          <p className="px-5 py-4 text-xs text-muted-foreground">
            {deferredSearch ? t("chat.noSearchResults") : showArchived ? t("chat.noArchived") : t("chat.noConversations")}
          </p>
        ) : (
          <>
            {pinned.length > 0 ? (
              <section aria-labelledby="chat-pinned-heading">
                <h3 id="chat-pinned-heading" className="px-5 pb-1 pt-2 text-(length:--text-micro) font-medium uppercase text-muted-foreground">
                  {t("chat.pinned")}
                </h3>
                {renderRows(pinned)}
              </section>
            ) : null}
            {recent.length > 0 ? (
              <section aria-labelledby="chat-recent-heading">
                <h3 id="chat-recent-heading" className="px-5 pb-1 pt-3 text-(length:--text-micro) font-medium uppercase text-muted-foreground">
                  {showArchived ? t("chat.archived") : t("chat.recent")}
                </h3>
                {renderRows(recent)}
              </section>
            ) : null}
          </>
        )}
      </nav>

      <div className="shrink-0 border-t border-border p-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived ? <MessageSquare className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          {showArchived ? t("chat.active") : t("chat.archived")}
        </Button>
      </div>

      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("chat.rename")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renaming && renameValue.trim()) {
                updateMutation.mutate({ id: renaming.id, patch: { title: renameValue.trim() } });
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => {
                if (!renaming || !renameValue.trim()) return;
                updateMutation.mutate({ id: renaming.id, patch: { title: renameValue.trim() } });
              }}
              disabled={!renameValue.trim() || updateMutation.isPending}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
