import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Bot, Check, CircleAlert, MessageSquare, RotateCcw, Square, Target } from "lucide-react";
import type { ConversationMessage } from "@paperclipai/shared";
import { directorTargetProposalSchema } from "@paperclipai/shared";
import { useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ChatComposer, type ChatComposerHandle } from "../components/ChatComposer";
import { MarkdownBody } from "../components/MarkdownBody";
import { conversationsApi } from "../api/conversations";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialogActions } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { ConversationTargetContext, ConversationContextChange, FocusCreatedTarget } from "../components/ConversationTargetContext";
import { ConversationTargetsPanel } from "../components/ConversationTargetsPanel";
import { useTranslation } from "@/i18n";
import { invocationQueryKey, useConversationInvocation } from "../hooks/useConversationInvocation";
import { startDurableConversationInvocation } from "../api/conversation-invocation-request";

const CHAT_MARKDOWN_CLASS =
  "max-w-full overflow-visible [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

function messageAssistantName(message: ConversationMessage) {
  const value = message.metadata?.assistantAgentName;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function Message({ message }: { message: ConversationMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === "user";

  return (
    <article className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser ? (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
      ) : null}
      <div
        className={cn(
          "min-w-0 max-w-3xl break-words text-sm",
          isUser
            ? "rounded-md bg-accent px-3 py-2 text-foreground"
            : "flex-1 py-1 text-foreground",
          message.status === "failed" && "text-muted-foreground",
        )}
      >
        {!isUser ? (
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {messageAssistantName(message) ?? t("chat.assistant")}
          </p>
        ) : null}
        {isUser ? message.body : (
          <MarkdownBody className={CHAT_MARKDOWN_CLASS}>{message.body}</MarkdownBody>
        )}
        {!isUser && message.status === "failed" ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
            <CircleAlert className="h-3.5 w-3.5" />
            {t("chat.failedResponse")}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function TargetProposal({ message, applied, disabled }: { message: ConversationMessage; applied: boolean; disabled: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const proposal = directorTargetProposalSchema.parse(message.metadata);
  const mutation = useMutation({
    mutationFn: () => conversationsApi.confirmTargetProposal(message.workspaceId, message.conversationId, message.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(message.workspaceId, message.conversationId) });
      await queryClient.invalidateQueries({ queryKey: ["targets"] });
    },
  });
  return (
    <article className="space-y-3 rounded-md border border-border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><Target className="h-4 w-4 shrink-0" />{proposal.targetTitle}</p>
      <p className="text-xs text-muted-foreground">{t(`chat.targetProposal.${proposal.input.operation}`)}</p>
      {proposal.input.operation === "archive" || proposal.input.operation === "restore" ? <p className="text-sm text-muted-foreground">{t(`chat.targetProposal.${proposal.input.operation}Notice`)}</p> : null}
      <p className="break-all font-mono text-xs text-muted-foreground">{proposal.input.expectedTargetRevisionId}</p>
      {(["title", "summary", "goal"] as const).map((key) => proposal.input[key] !== undefined ? (
        <div key={key}><p className="text-xs font-medium text-muted-foreground">{t(`chat.targetProposal.${key}`)}</p><del className="block whitespace-pre-wrap break-words text-muted-foreground">{proposal.before[key]}</del><ins className="block whitespace-pre-wrap break-words no-underline">{proposal.input[key]}</ins></div>
      ) : null)}
      {mutation.isError ? <p role="alert" className="text-destructive">{mutation.error.message}</p> : null}
      <Button size="sm" variant={proposal.input.operation === "cancel" && !applied && !mutation.isSuccess ? "destructive" : "outline"} disabled={disabled || applied || mutation.isPending || mutation.isSuccess} onClick={() => mutation.mutate()}>
        {proposal.input.operation === "archive" ? <Archive className="h-4 w-4" /> : proposal.input.operation === "restore" ? <ArchiveRestore className="h-4 w-4" /> : <Check className="h-4 w-4" />}{t(applied || mutation.isSuccess ? "chat.targetProposal.applied" : "chat.targetProposal.confirm")}
      </Button>
    </article>
  );
}

export function VerrailChat() {
  const { t } = useTranslation();
  const { conversationId: routeConversationId } = useParams<{ conversationId?: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewTarget } = useDialogActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);
  const conversationId = routeConversationId ?? createdConversationId;
  const [input, setInput] = useState("");
  const [localSending, setSending] = useState(false);
  const [localStreamingText, setStreamingText] = useState("");
  const [streamingAssistantName, setStreamingAssistantName] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const [localErrorText, setErrorText] = useState("");
  const [lastSubmitted, setLastSubmitted] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const internalNavigationIdRef = useRef<string | null>(null);
  const previousRouteConversationIdRef = useRef(routeConversationId);
  const previousWorkspaceRef = useRef(selectedCompanyId);
  const runtimeQuery = useQuery({
    queryKey: ["conversation-runtime", selectedCompanyId],
    queryFn: () => conversationsApi.runtime(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const gatewayMode = runtimeQuery.data?.mode === "execution_gateway";
  const invocation = useConversationInvocation(selectedCompanyId, conversationId, gatewayMode);
  const sending = localSending || Boolean(invocation.active);
  const streamingText = gatewayMode ? invocation.active?.output ?? localStreamingText : localStreamingText;
  const errorText = localErrorText || (runtimeQuery.error || invocation.error || runtimeQuery.data?.mode === "unavailable" || (gatewayMode && invocation.latest?.status === "failed") ? t("chat.unavailable") : gatewayMode && invocation.latest?.status === "canceled" ? t("chat.stopped") : "");

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.chat") }]);
  }, [setBreadcrumbs, t]);

  useEffect(() => {
    const workspaceChanged = previousWorkspaceRef.current !== selectedCompanyId;
    previousWorkspaceRef.current = selectedCompanyId;
    if (!workspaceChanged && previousRouteConversationIdRef.current === routeConversationId) return;
    previousRouteConversationIdRef.current = routeConversationId;
    if (!workspaceChanged && routeConversationId && internalNavigationIdRef.current === routeConversationId) {
      internalNavigationIdRef.current = null;
      setCreatedConversationId(null);
      return;
    }
    requestSequenceRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setCreatedConversationId(null);
    setSending(false);
    setStreamingText("");
    setStreamingAssistantName("");
    setOptimisticMessage(null);
    setErrorText("");
  }, [routeConversationId, selectedCompanyId]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const conversationQuery = useQuery({
    queryKey: selectedCompanyId && conversationId
      ? queryKeys.conversations.detail(selectedCompanyId, conversationId)
      : ["conversations", "detail", "disabled"],
    queryFn: () => conversationsApi.get(selectedCompanyId!, conversationId!),
    enabled: Boolean(selectedCompanyId && conversationId),
    refetchInterval: 5_000,
  });
  const draftsQuery = useQuery({
    queryKey: selectedCompanyId && conversationId
      ? queryKeys.conversations.drafts(selectedCompanyId, conversationId)
      : ["conversations", "drafts", "disabled"],
    queryFn: () => conversationsApi.listTargetDrafts(selectedCompanyId!, conversationId!),
    enabled: Boolean(selectedCompanyId && conversationId),
    refetchInterval: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: () => conversationsApi.create(selectedCompanyId!),
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: sending ? "smooth" : "auto", block: "end" });
  }, [conversationQuery.data?.messages.length, optimisticMessage, sending, streamingText]);

  const sendMessage = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || !selectedCompanyId || sending || runtimeQuery.isPending || runtimeQuery.isError || invocation.loading || runtimeQuery.data?.mode === "unavailable") return;
    if (conversationQuery.data?.status === "archived") return;

    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;

    setSending(true);
    setInput("");
    setLastSubmitted(trimmed);
    setOptimisticMessage(trimmed);
    setStreamingText("");
    setStreamingAssistantName("");
    setErrorText("");

    let targetConversationId = conversationId;
    let controller: AbortController | null = null;
    try {
      if (!targetConversationId) {
        const created = await createMutation.mutateAsync();
        targetConversationId = created.id;
        setCreatedConversationId(created.id);
        internalNavigationIdRef.current = created.id;
        await queryClient.invalidateQueries({
          queryKey: queryKeys.conversations.all(selectedCompanyId),
        });
        navigate(`/chat/${created.id}`, { replace: true });
      }

      if (gatewayMode) {
        const result = await startDurableConversationInvocation(selectedCompanyId, targetConversationId, trimmed);
        await queryClient.cancelQueries({ queryKey: invocationQueryKey(selectedCompanyId, targetConversationId) });
        queryClient.setQueryData(invocationQueryKey(selectedCompanyId, targetConversationId), [result.invocation]);
        return;
      }
      controller = new AbortController();
      abortControllerRef.current = controller;
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(selectedCompanyId)}/conversations/${encodeURIComponent(targetConversationId)}/messages/stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: trimmed }),
          signal: controller.signal,
        },
      );

      if (!response.ok || !response.body) {
        throw new Error(t("chat.unavailable"));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let streamError = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type?: string;
              text?: string;
              message?: string;
              assistantAgentName?: string | null;
            };
            if (event.type === "start" && event.assistantAgentName) {
              if (requestSequenceRef.current === requestSequence) {
                setStreamingAssistantName(event.assistantAgentName);
              }
            } else if (event.type === "chunk" && event.text) {
              accumulated += event.text;
              if (requestSequenceRef.current === requestSequence) {
                setStreamingText(accumulated);
              }
            } else if (event.type === "error") {
              streamError = event.message || t("chat.unavailable");
            }
          } catch {
            // Ignore malformed event lines while preserving the rest of the stream.
          }
        }
      }

      if (streamError) throw new Error(streamError);
    } catch (error) {
      if (requestSequenceRef.current === requestSequence) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setErrorText(t("chat.stopped"));
        } else {
          setErrorText(error instanceof Error && error.message ? error.message : t("chat.unavailable"));
        }
      }
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      if (targetConversationId) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.conversations.detail(selectedCompanyId, targetConversationId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.conversations.all(selectedCompanyId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.conversations.drafts(selectedCompanyId, targetConversationId),
          }),
        ]);
      }
      if (requestSequenceRef.current === requestSequence) {
        setSending(false);
        setStreamingText("");
        setStreamingAssistantName("");
        setOptimisticMessage(null);
        composerRef.current?.focus();
      }
    }
  }, [
    conversationId,
    conversationQuery.data?.status,
    createMutation,
    navigate,
    queryClient,
    selectedCompanyId,
    sending,
    gatewayMode,
    runtimeQuery.isPending,
    runtimeQuery.isError,
    runtimeQuery.data?.mode,
    invocation.loading,
    t,
  ]);

  const stopStreaming = () => gatewayMode ? invocation.cancel.mutate() : abortControllerRef.current?.abort();
  const restoreDraft = () => {
    setInput(lastSubmitted);
    setErrorText("");
    composerRef.current?.focus();
  };

  const conversation = conversationQuery.data;
  const isArchived = conversation?.status === "archived";
  const hasMessages = Boolean(conversation?.messages.length || optimisticMessage || streamingText || sending);
  const showOptimisticMessage = Boolean(
    optimisticMessage
      && !conversation?.messages.some(
        (message) => message.role === "user" && message.body === optimisticMessage,
      ),
  );

  if (conversationId && conversationQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("chat.loadingConversation")}
      </div>
    );
  }

  if (conversationId && conversationQuery.error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center">
          <CircleAlert className="mx-auto h-5 w-5 text-destructive" />
          <h2 className="mt-3 text-base font-semibold">{t("chat.loadFailed")}</h2>
          <Button className="mt-4" variant="outline" onClick={() => conversationQuery.refetch()}>
            <RotateCcw className="h-4 w-4" />
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="-m-4 flex h-(--sz-verrail-chat-mobile) min-h-0 flex-col md:-m-6 md:h-(--sz-calc-29)">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {conversation?.title && conversation.title !== "New conversation"
              ? conversation.title
              : t("chat.new")}
          </h1>
        </div>
        {conversation ? <div className="flex max-w-full flex-wrap items-center gap-1"><ConversationTargetContext key={conversation.id} conversation={conversation} /><ConversationTargetsPanel key={`targets-${conversation.id}`} conversation={conversation} onCreateTarget={() => openNewTarget({ conversationId: conversation.id })} /></div> : null}
      </header>

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto scrollbar-auto-hide">
          <div className="mx-auto flex min-h-full max-w-4xl flex-col px-5 py-6 md:px-8">
            {draftsQuery.isError ? (
              <div role="alert" className="mb-4 flex items-center gap-3 border-b border-border pb-3 text-sm text-destructive">
                <p className="min-w-0 flex-1">{t("targets.create.errors.loadDrafts")}</p>
                <Button variant="ghost" size="icon-sm" title={t("common.retry")} aria-label={t("common.retry")} onClick={() => void draftsQuery.refetch()}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
            {(draftsQuery.data ?? []).filter((draft) => ["collecting", "ready_for_confirmation", "converting", "converted"].includes(draft.status)).map((draft) => (
              <div key={draft.id} className="mb-4 flex flex-wrap items-center gap-3 border-b border-border pb-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{draft.activeRevision.definition.title ?? t("targets.create.untitledDraft")}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{draft.id} · v{draft.activeRevisionNumber}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => openNewTarget({ conversationId: draft.conversationId, draft })}>
                  <Target className="h-4 w-4" />
                  {t(draft.status === "converted" ? "targets.create.reply.title" : "targets.create.resume")}
                </Button>
                {draft.status === "converted" && draft.convertedTargetId && conversation ? <FocusCreatedTarget conversation={conversation} targetId={draft.convertedTargetId} /> : null}
              </div>
            ))}
            {!hasMessages ? (
              <div className="flex flex-1 items-center justify-center py-10">
                <div className="max-w-xl text-center">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted">
                    <MessageSquare className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <h2 className="mt-4 text-lg font-semibold">{t("chat.emptyTitle")}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("chat.emptyPrompt")}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {conversation?.messages.map((message) => {
                  if (message.role === "tool" && message.metadata?.kind === "conversation_context_changed") return <ConversationContextChange key={message.id} conversation={conversation} message={message} />;
                  if (message.role === "tool" && message.metadata?.kind === "director_target_read") return <p key={message.id} className="flex items-center gap-2 text-xs text-muted-foreground"><Target className="h-3.5 w-3.5 shrink-0" />{t("chat.targetProposal.queried")}{message.metadata.tool === "get_target" ? `: ${message.body}` : ` (${message.metadata.total})`}</p>;
                  if (message.role === "tool" && message.metadata?.kind === "director_target_result") return null;
                  if (message.role === "tool" && directorTargetProposalSchema.safeParse(message.metadata).success) {
                    const applied = conversation.messages.some((entry) => entry.role === "tool" && entry.metadata?.kind === "director_target_result" && entry.metadata.proposalMessageId === message.id);
                    return <TargetProposal key={message.id} message={message} applied={applied} disabled={isArchived || sending} />;
                  }
                  return <Message key={message.id} message={message} />;
                })}
                {showOptimisticMessage && optimisticMessage ? (
                  <Message
                    message={{
                      id: "optimistic-user-message",
                      workspaceId: selectedCompanyId ?? "",
                      conversationId: conversationId ?? "",
                      role: "user",
                      status: "complete",
                      body: optimisticMessage,
                      authorPrincipalType: "user",
                      authorPrincipalId: "local",
                      metadata: null,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    }}
                  />
                ) : null}
                {sending ? (
                  <article className="flex gap-3">
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                      <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1 py-1 text-sm">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        {streamingAssistantName || t("chat.assistant")}
                      </p>
                      {streamingText ? (
                        <MarkdownBody className={CHAT_MARKDOWN_CLASS}>{streamingText}</MarkdownBody>
                      ) : (
                        <p className="text-muted-foreground">{t("chat.thinking")}</p>
                      )}
                      {invocation.active?.status === "cancel_requested" ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("chat.stopping")}</p> : null}
                    </div>
                  </article>
                ) : null}
                {errorText ? (
                  <div role="alert" className="flex items-start gap-3 border-t border-border pt-4 text-sm text-destructive">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="min-w-0 flex-1">{errorText}</p>
                    {lastSubmitted ? (
                      <Button variant="ghost" size="sm" onClick={restoreDraft}>
                        <RotateCcw className="h-4 w-4" />
                        {t("chat.restoreDraft")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-background px-4 py-3 md:px-8">
        <div className="mx-auto max-w-4xl">
          {isArchived ? (
            <p className="py-2 text-center text-sm text-muted-foreground">{t("chat.archivedNotice")}</p>
          ) : (
            <ChatComposer
              ref={composerRef}
              value={input}
              onChange={setInput}
              onSubmit={() => void sendMessage(input)}
              placeholder={t("chat.placeholder")}
              disabled={!selectedCompanyId || runtimeQuery.isPending || runtimeQuery.isError || runtimeQuery.data?.mode === "unavailable" || invocation.loading}
              submitting={sending}
              submitKey="enter"
              autoFocus
              sendLabel={t("chat.send")}
              trailingTools={sending ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={stopStreaming}
                  disabled={gatewayMode && (!invocation.active || invocation.active.status === "cancel_requested" || invocation.cancel.isPending)}
                  aria-label={t("chat.stop")}
                  title={t("chat.stop")}
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            />
          )}
          <p className="mt-2 text-center text-(length:--text-micro) text-muted-foreground">
            {t("chat.nonAuthoritative")}
          </p>
        </div>
      </footer>
    </div>
  );
}
