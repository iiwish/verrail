# G1 Domain Closure

## Goal

G1 establishes one native, inspectable path from an explicit conversational
request to a human-confirmed Target and onward to an activated WorkGraph and a
persistent Run. It freezes the domain boundary before the later delivery proof
and acceptance loop is added.

## Canonical Boundary

- Target belongs directly to Workspace and may reference a native Collection.
- Project, Case, Issue, inherited Artifact, and Heartbeat Run remain in the
  Compatibility Service and never become native TargetReadModel facts.
- Go Domain API owns native Target, TargetRevision, WorkGraph, GraphRevision,
  WorkNode, Run, audit, outbox, and command receipt writes.
- PostgreSQL owns business truth. Temporal receives committed Target and graph
  activation events and performs durable orchestration without owning domain
  transitions.
- Conversation, ConversationMessage, ProviderConversationBinding, and
  TargetCreationDraft are persistent interaction facts, not delivery truth.

## Conversation-First Creation

Ordinary messages do not create a draft or Target. A structured explicit intent
references a source message and creates a draft with immutable revisions. Missing
required fields keep the draft in `collecting`; a complete revision becomes
`ready_for_confirmation`. Only a human Workspace member can confirm that exact
revision. Confirmation fixes a deterministic idempotency key, and retries by the
same principal return the original complete Target response. Another principal
cannot take over an in-flight or completed confirmation.

## Minimal Delivery Loop

Target creation atomically establishes an empty WorkGraph and initial draft
GraphRevision. A human can create a version-bound graph revision whose nodes have
explicit kinds, stages, responsibility, dependency keys, and completion
definitions. The graph must be acyclic. Activation supersedes the former active
revision, makes roots ready, writes audit and outbox facts, and is idempotent.

A native Run can be created only for a ready `agent_task` or `integration_task`
on the active graph revision. Run creation persists actor, target revision,
graph revision, node, state, and idempotency identity, then moves the node to
`running`. The read model derives four stable stages, native work, actionable
attention, native runs, and the native audit timeline.

## Non-goals

- Run completion, retry scheduling, lease/fencing, or execution output ingestion.
- Submission, ArtifactRevision, Evidence, VerificationResult, DeliveryReview, or
  Acceptance commands.
- GitHub, CI, or enterprise channel connector completion.
- Deleting inherited compatibility APIs or storage.
- Commit, merge, deployment, release, or ship authority.

## Acceptance

Acceptance is defined by `target.json`. Automated evidence covers migrations,
validators, workspace authorization, draft revision and confirmation ownership,
command idempotency and rollback, graph activation, Run creation, native read
models, OpenAPI parity, UI behavior, locale parity, token gates, build, Go tests,
and browser acceptance. Independent engineering review and product-owner
acceptance remain required before merge or shipping.
