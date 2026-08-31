import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CircleAlert, MessageSquare, RotateCcw, Square } from "lucide-react";
import type { ConversationMessage } from "@paperclipai/shared";
import { useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ChatComposer, type ChatComposerHandle } from "../components/ChatComposer";
import { MarkdownBody } from "../components/MarkdownBody";
import { conversationsApi } from "../api/conversations";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { useTranslation } from "@/i18n";

const CHAT_MARKDOWN_CLASS =
  "max-w-full overflow-visible [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

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
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t("chat.assistant")}</p>
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

export function VerrailChat() {
  const { t } = useTranslation();
  const { conversationId: routeConversationId } = useParams<{ conversationId?: string }>();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);
  const conversationId = routeConversationId ?? createdConversationId;
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState("");
  const [lastSubmitted, setLastSubmitted] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const internalNavigationIdRef = useRef<string | null>(null);
  const previousRouteConversationIdRef = useRef(routeConversationId);

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.chat") }]);
  }, [setBreadcrumbs, t]);

  useEffect(() => {
    if (previousRouteConversationIdRef.current === routeConversationId) return;
    previousRouteConversationIdRef.current = routeConversationId;
    if (routeConversationId && internalNavigationIdRef.current === routeConversationId) {
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
    setOptimisticMessage(null);
    setErrorText("");
  }, [routeConversationId]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const conversationQuery = useQuery({
    queryKey: selectedCompanyId && conversationId
      ? queryKeys.conversations.detail(selectedCompanyId, conversationId)
      : ["conversations", "detail", "disabled"],
    queryFn: () => conversationsApi.get(selectedCompanyId!, conversationId!),
    enabled: Boolean(selectedCompanyId && conversationId),
  });

  const createMutation = useMutation({
    mutationFn: () => conversationsApi.create(selectedCompanyId!),
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: sending ? "smooth" : "auto", block: "end" });
  }, [conversationQuery.data?.messages.length, optimisticMessage, sending, streamingText]);

  const sendMessage = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || !selectedCompanyId || sending) return;
    if (conversationQuery.data?.status === "archived") return;

    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;

    setSending(true);
    setInput("");
    setLastSubmitted(trimmed);
    setOptimisticMessage(trimmed);
    setStreamingText("");
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
            };
            if (event.type === "chunk" && event.text) {
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
        ]);
      }
      if (requestSequenceRef.current === requestSequence) {
        setSending(false);
        setStreamingText("");
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
    t,
  ]);

  const stopStreaming = () => abortControllerRef.current?.abort();
  const restoreDraft = () => {
    setInput(lastSubmitted);
    setErrorText("");
    composerRef.current?.focus();
  };

  const conversation = conversationQuery.data;
  const isArchived = conversation?.status === "archived";
  const hasMessages = Boolean(conversation?.messages.length || optimisticMessage || streamingText);
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
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {conversation?.title && conversation.title !== "New conversation"
              ? conversation.title
              : t("chat.new")}
          </h1>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {selectedCompany?.name ?? t("chat.workspaceContext")}
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {conversation?.contextBindings.map((binding) => (
            <span
              key={binding.id}
              className="max-w-48 truncate rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
              title={binding.label ?? binding.contextId}
            >
              {binding.label ?? binding.contextId}
            </span>
          ))}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto scrollbar-auto-hide">
          <div className="mx-auto flex min-h-full max-w-4xl flex-col px-5 py-6 md:px-8">
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
                {conversation?.messages.map((message) => <Message key={message.id} message={message} />)}
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
                      <p className="mb-1 text-xs font-medium text-muted-foreground">{t("chat.assistant")}</p>
                      {streamingText ? (
                        <MarkdownBody className={CHAT_MARKDOWN_CLASS}>{streamingText}</MarkdownBody>
                      ) : (
                        <p className="text-muted-foreground">{t("chat.thinking")}</p>
                      )}
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
              disabled={!selectedCompanyId}
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
