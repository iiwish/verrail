# Governed Native New Target Command Spec

## Problem

The B2 read path can display explicitly mapped compatibility Targets, but users
cannot create a native Target. A Case or Issue surrogate would make the UI look
complete while preserving the wrong domain owner.

## Goal

Create a real Target and immutable first TargetRevision, then route directly to
the canonical Workbench with stable IDs and inspectable command evidence.

## Command Contract

The command accepts:

- Workspace and Project UUIDs;
- title and optional summary;
- outcome-owner Principal;
- goal and constraints;
- one or more acceptance criteria;
- risk level and optional deadline;
- applicable policy summary;
- a bounded client idempotency key.

The transaction creates:

- one stable Target;
- one immutable TargetRevision;
- one AuditEvent;
- one local outbox event;
- one idempotency receipt bound to Principal, Workspace, command type, and
  canonical request hash.

Temporal is not required for this command. Workflow activation is a later
consumer of the committed outbox fact.

## Read Integration

The canonical Target read contract must represent both native and compatibility
Targets without allowing compatibility projections to overwrite native facts.
Every result identifies its authority kind. Native TargetRevision data is read
from the domain tables; Case and Issue data remains a rebuildable projection.

## UX Contract

New Target is available only with Verrail navigation enabled and from a
selected Project or global command that requires Project selection. Success
navigates to the server-issued Target Workbench URL. The form never presents a
Case or Issue as the created object.

## Authority Contract

ADR-0004 assigns this aggregate to the Go Domain API. The approved minimum Go
slice makes that service the sole writer of native Target, TargetRevision,
command receipt, AuditEvent, and outbox facts. TypeScript remains the session
and authorization edge, command proxy, and unified read layer. This slice does
not start Temporal or create a second native writer.

## Acceptance Criteria

The acceptance criteria in target.json are authoritative.

## Risks

- A temporary TypeScript writer creates a second migration and weakens the
  accepted cutover model.
- A Case surrogate produces false Target semantics and invalid future evidence.
- Non-atomic audit or outbox writes make a successful command ungovernable.
- Principal-insensitive idempotency can disclose or replay another user's
  command.
