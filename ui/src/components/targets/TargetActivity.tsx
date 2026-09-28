import type { TargetTimelineEventV1 } from "@paperclipai/shared";
import { useState } from "react";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { formatDateTime } from "@/lib/utils";

const EVENT_LABELS: Record<string, string> = {
  "graph.reconciled": "graphReconciled", "run.event_failed": "runFailed", "run.event_terminated": "runEnded",
  "run.event_cancel_acknowledged": "runCanceled", "run.cancellation_requested": "cancelRequested", "run.event_started": "runStarted",
  "run.event_heartbeat": "heartbeat", "run.event_claimed": "runClaimed", "run.attempt_created": "attemptCreated",
  "run.lease_expired": "leaseExpired", "run.outbox_retry_requested": "deliveryRetry", "run.event_rejected_expired_lease": "expiredEvent",
};

export function isUnchangedReconciliation(event: TargetTimelineEventV1): boolean {
  if (event.type !== "domain_event" || event.title !== "graph.reconciled" || !event.detail) return false;
  try {
    const payload = JSON.parse(event.detail);
    return payload?.schemaVersion === 1 && Array.isArray(payload.activatedNodeIds) && payload.activatedNodeIds.length === 0
      && Array.isArray(payload.gateTransitions) && payload.gateTransitions.length === 0;
  } catch {
    return false;
  }
}

export function partitionActivity(events: TargetTimelineEventV1[]) {
  const visible: TargetTimelineEventV1[] = [];
  const system: TargetTimelineEventV1[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    let repeatKey: string | null = null;
    if (event.type === "domain_event" && event.title === "run.event_heartbeat") repeatKey = `${event.aggregateId}:heartbeat`;
    if (event.type === "domain_event" && event.title === "graph.reconciled" && event.detail) {
      try {
        const payload = JSON.parse(event.detail);
        if (payload?.schemaVersion === 1 && Array.isArray(payload.activatedNodeIds) && payload.activatedNodeIds.length === 0 && payload.gateTransitions === undefined) {
          repeatKey = `${event.aggregateId}:${event.detail}`;
        }
      } catch { /* Unrecognized audit payloads remain visible. */ }
    }
    if (isUnchangedReconciliation(event) || (repeatKey && seen.has(repeatKey))) system.push(event);
    else visible.push(event);
    if (repeatKey) seen.add(repeatKey);
  }
  return { visible, system };
}

export function TargetActivity({ events, targetId }: { events: TargetTimelineEventV1[]; targetId: string }) {
  const { t } = useTranslation();
  const [showSystem, setShowSystem] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const sorted = [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const { visible, system } = partitionActivity(sorted);
  const renderEvents = (items: TargetTimelineEventV1[]) => <ol className="divide-y divide-border border-y border-border">
    {items.map((event) => {
      const destination = event.type.startsWith("run_") || event.title.startsWith("run.") ? "runs" : /submission|review|acceptance/.test(event.type) ? "delivery" : "overview";
      return <li key={event.id} className="space-y-2 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 break-words text-sm font-medium">{EVENT_LABELS[event.title] ? t(`targets.activityKinds.${EVENT_LABELS[event.title]}`) : event.type === "domain_event" ? event.title : t(`targets.timelineEvents.${event.type}`)}</p>
          <time className="text-xs text-muted-foreground" dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
        </div>
        {event.detail || event.aggregateId ? <details className="text-xs text-muted-foreground" onToggle={(change) => {
          const open = change.currentTarget.open;
          setExpanded((current) => {
            if (current.has(event.id) === open) return current;
            const next = new Set(current);
            if (open) next.add(event.id); else next.delete(event.id);
            return next;
          });
        }}>
          <summary className="cursor-pointer">{t("targets.delivery.auditDetails")}</summary>
          {expanded.has(event.id) ? <>
          <p className="mt-2 break-all font-mono">{event.aggregateType} · {event.aggregateId}</p>
          {event.detail ? <pre className="mt-2 whitespace-pre-wrap break-all font-mono">{event.detail}</pre> : null}
          <Link to={`/targets/${targetId}/${destination}`} className="mt-2 inline-block underline">{t("targets.delivery.source")}</Link>
          </> : null}
        </details> : null}
      </li>;
    })}
  </ol>;
  return <div className="space-y-4">
    {renderEvents(visible)}
    {system.length ? <details onToggle={(event) => setShowSystem(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{t("targets.delivery.systemEvents", { count: system.length })}</summary>{showSystem ? renderEvents(system) : null}</details> : null}
  </div>;
}
