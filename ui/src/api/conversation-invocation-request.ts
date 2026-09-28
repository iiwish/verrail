import { conversationsApi } from "./conversations";

export async function startDurableConversationInvocation(workspaceId: string, conversationId: string, body: string) {
  const storageKey = `verrail:pending-invocation:${workspaceId}:${conversationId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  let pending: { hash: string; idempotencyKey: string } | undefined;
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (raw?.hash === hash && typeof raw.idempotencyKey === "string") pending = raw;
  } catch { /* Invalid local state cannot supply invocation authority. */ }
  pending ??= { hash, idempotencyKey: crypto.randomUUID() };
  // Persist before admission so a lost response can be retried after navigation.
  sessionStorage.setItem(storageKey, JSON.stringify(pending));
  const result = await conversationsApi.startInvocation(workspaceId, conversationId, body, pending.idempotencyKey);
  if (sessionStorage.getItem(storageKey) === JSON.stringify(pending)) sessionStorage.removeItem(storageKey);
  return result;
}
