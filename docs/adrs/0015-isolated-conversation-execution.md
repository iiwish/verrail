# ADR 0015: Isolated Conversation Execution

Status: Accepted architecture; deployment acceptance is tracked separately.

## Decision

The control plane owns authenticated ConversationInvocation admission, immutable
version/input identity, membership authorization, durable events and replies.
An internal execution gateway owns a separate OpenCode subprocess per invocation.
The gateway has no control-plane database credentials and is not public ingress.

Each subprocess receives isolated HOME/XDG directories, a generated loopback HTTP
credential, operator-selected provider configuration and a short-lived signed
Director capability. OpenCode directory selection is not an authorization boundary.
Only the six registered Director tools are allowed; arbitrary shell or plugin
execution is outside this profile. Process separation is not a hostile-code sandbox.

The signed capability selects an immutable persisted invocation. Every callback
checks expiration, active invocation state and current workspace membership.
Tool authorization is counted durably under the invocation lock, with a limit of
20. The source message, principal, agent version and deployment revision come from
the persisted invocation, never tool arguments. Proposals require the existing
human confirmation path and cannot grant approval or acceptance authority.

The controller holds a renewable lease and fencing token for event writes. It
records dispatch intent before sending work. After an ambiguous submission, it
queries durable gateway state rather than repeating the submission. Missing state
is reported as failure. Gateway restart fails interrupted invocations without
replaying effects. Terminal replies and their final events commit together.

Browser disconnect stops event delivery only. Explicit cancellation revokes tool
authorization immediately and awaits gateway process cleanup before cancellation
is acknowledged. Unknown runtime state or cleanup failure is failure, not a claim
that execution stopped successfully. Target Run authority remains in the Go Graph
Engine and is not replaced by ConversationInvocation.

## Operational Consequences

The gateway volume requires a single-writer process lock, private permissions and
container-wide process cleanup on restart. Provider secrets and signing secrets
are mounted separately. The control plane and gateway require private mutual
connectivity; the public browser receives neither secret nor internal input data.

The local CLI compatibility route remains separate. Configuring the gateway does
not constitute full deployment acceptance: authenticated browser flows, fixed
OpenCode publication, shared PostgreSQL/Temporal storage, container verification,
backup and platform gates must pass before a candidate is declared deployable.
