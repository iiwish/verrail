import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { conversationInvocationEventSchema, type ConversationInvocationView } from "@paperclipai/shared";
import { conversationsApi } from "../api/conversations";
import { queryKeys } from "../lib/queryKeys";

export const invocationQueryKey = (workspaceId: string, conversationId: string) => ["conversation-invocations", workspaceId, conversationId] as const;

export function useConversationInvocation(workspaceId: string | null, conversationId: string | null | undefined, enabled: boolean) {
  const client = useQueryClient();
  const key = invocationQueryKey(workspaceId ?? "", conversationId ?? "");
  const query = useQuery({
    queryKey: key,
    queryFn: () => conversationsApi.invocations(workspaceId!, conversationId!),
    enabled: enabled && Boolean(workspaceId && conversationId),
    refetchInterval: enabled ? 2000 : false,
    structuralSharing: (previous, next) => {
      const oldRows = previous as ConversationInvocationView[] | undefined;
      return (next as ConversationInvocationView[]).map(row => {
        const old = oldRows?.find(item => item.id === row.id);
        if (!old || row.finishedAt) return row;
        return { ...row,
          ...(old.lastEventCursor > row.lastEventCursor ? { output: old.output, lastEventCursor: old.lastEventCursor } : {}),
          status: old.status === "cancel_requested" || row.status === "cancel_requested" ? "cancel_requested" : row.status,
        };
      });
    },
  });
  const rows = enabled ? query.data : undefined;
  const active = rows?.find(row => !row.finishedAt);
  const activeId = active?.id;
  const latest = rows?.[0];
  useEffect(() => {
    if (!enabled || !workspaceId || !conversationId || !activeId) return;
    const key = invocationQueryKey(workspaceId, conversationId);
    const snapshot = client.getQueryData<ConversationInvocationView[]>(key)?.find(row => row.id === activeId);
    if (!snapshot) return;
    const events = new EventSource(`/api/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/invocations/${encodeURIComponent(activeId)}/events?after=${snapshot.lastEventCursor}`);
    const receive = (raw: MessageEvent) => {
      try {
        const event = conversationInvocationEventSchema.parse({ type: raw.type, data: JSON.parse(raw.data) });
        const cursor = Number(raw.lastEventId);
        if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error("Invalid invocation cursor");
        if (event.type === "done" || event.type === "error") {
          events.close();
          void client.invalidateQueries({ queryKey: key });
          return;
        }
        client.setQueryData<ConversationInvocationView[]>(key, current => current?.map(row => {
          if (row.id !== activeId || row.lastEventCursor >= cursor) return row;
          if (row.lastEventCursor + 1 !== cursor) return row;
          return { ...row, lastEventCursor: cursor,
            output: event.type === "chunk" ? row.output + event.data.text : row.output,
            status: event.type === "cancel_requested" ? "cancel_requested" : event.type === "start" && row.status === "queued" ? "running" : row.status,
          };
        }));
      } catch { void client.invalidateQueries({ queryKey: key }); }
    };
    for (const name of ["start", "chunk", "cancel_requested", "done", "error"]) events.addEventListener(name, receive as EventListener);
    // Native SSE reconnects; polling also recovers durable output after missed events.
    return () => events.close();
  }, [enabled, workspaceId, conversationId, activeId, client]);
  useEffect(() => {
    if (!latest?.finishedAt || !workspaceId || !conversationId) return;
    void client.invalidateQueries({ queryKey: queryKeys.conversations.detail(workspaceId, conversationId) });
    void client.invalidateQueries({ queryKey: queryKeys.conversations.all(workspaceId) });
    void client.invalidateQueries({ queryKey: queryKeys.conversations.drafts(workspaceId, conversationId) });
  }, [latest?.id, latest?.finishedAt, workspaceId, conversationId, client]);
  const cancel = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !conversationId || !activeId) return;
      return conversationsApi.cancelInvocation(workspaceId, conversationId, activeId);
    },
    onSuccess: row => {
      if (row) client.setQueryData<ConversationInvocationView[]>(key, current => current?.map(item => item.id === row.id ? row : item));
    },
  });
  return { active, latest, cancel, error: query.error ?? cancel.error, loading: enabled && Boolean(conversationId) && query.isPending };
}
