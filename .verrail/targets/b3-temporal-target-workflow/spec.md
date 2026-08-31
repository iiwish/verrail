# Durable Target Orchestration Handoff Spec

## Problem

Native Target creation commits an outbox event atomically with Target facts, but
no durable consumer currently turns that event into a Temporal execution. A
direct request-to-Workflow call would couple business commit success to Temporal
availability and would bypass the recovery boundary established by ADR-0003.

## Goal

Reliably hand each supported Target outbox event to one long-lived,
versioned `TargetWorkflow` while keeping Postgres authoritative for business and
delivery facts and keeping Temporal authoritative only for orchestration history.

## Delivery Contract

The Go orchestration worker owns the dispatcher and Temporal worker. The
dispatcher:

- claims only committed, available outbox rows;
- preserves event order within an aggregate;
- fences each claim with a unique token and an expiring lease;
- releases the database transaction before contacting Temporal;
- uses `SignalWithStart` with the outbox event ID as the delivery identity;
- records the Workflow and Run IDs after successful delivery;
- retries transport and availability failures with bounded exponential backoff;
- marks unsupported or exhausted events as failed with an inspectable error.

Delivery is at least once. Duplicate Temporal delivery is expected and handled
by the Workflow. No component claims exactly-once processing.

## Workflow Contract

The first Workflow is named `verrail.target.workflow.v1`, runs on task queue
`verrail-target-v1`, receives `verrail.target.event.v1` signals, and exposes the
`verrail.target.state.v1` query. Its Workflow ID is stable for the Workspace and
Target.

Workflow input and signals contain only schema version, opaque identifiers,
event type, and event time. The Workflow does not read or write Target tables,
activate Graph nodes, execute agents, or decide acceptance. It records minimal
orchestration state, ignores duplicate and cross-aggregate signals, and uses
Continue-As-New after a bounded number of accepted events.

## Failure Contract

Temporal unavailability does not affect a committed Target. The outbox row
stays pending or becomes reclaimable after its lease. A worker crash after
Temporal delivery and before the database acknowledgement can redeliver the
same event; Workflow deduplication makes this harmless. Unsupported contracts
and retry exhaustion are terminal, visible outbox failures that require an
operator or a later repair command.

## Runtime Contract

The Domain API and orchestration worker remain separate processes in the same Go
module. Local development uses a pinned Temporal development server. Production
deployment topology and high availability remain a later operational decision;
the event, Workflow, and task-queue contracts are the same in every environment.

## Acceptance Criteria

The acceptance criteria in `target.json` are authoritative.

## Risks

- Holding a database transaction during the Temporal call can exhaust locks and
  makes failure recovery ambiguous.
- Claim acknowledgement without fencing can let an expired worker overwrite a
  newer delivery attempt.
- Unbounded Workflow history makes replay increasingly expensive.
- Treating Workflow query state as Target truth would create a second domain
  authority.
- Automatic local startup could hide missing Temporal dependencies and make the
  existing development path brittle.
