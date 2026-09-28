# ADR-0012: Conversation Current Target

Status: Accepted

## Decision

Conversation is a Workspace-scoped system operation entry point. It stores zero or one current Target independently from its many ContextBinding references. Focus is not an authorization boundary and does not grant Agent approval or acceptance authority.

The TypeScript Compatibility API owns the conversation context command during domain migration. It stores currentTargetId/contextVersion and an immutable context-change receipt; the same transaction writes the visible context event and activity audit. The command checks the invoking human's active membership, the Target's Workspace, an expected context version and an idempotency key. Model tools receive invocation-scoped identity and cannot choose another conversation or Workspace.

Each user request records a context snapshot. A Director focus switch is bounded to the source request's context version. Refetching cannot silently overwrite an intervening human switch. Target commands still carry explicit object and domain-version references, independent of persistent focus.

Creation finalization only focuses a Target when the conversation remains empty at the version captured during confirmation. Idempotent replay never repeats focus selection. Existing ContextBindings remain related references and are not interpreted as implicit focus during migration.

## Consequences

Users can change focus manually or by explicit conversation intent without additional domain approval. One-off reads do not change focus. Shared conversations expose context changes to all authorized participants; competing changes return conflicts rather than using last-writer-wins.

The UI provides version-bound undo, related Target navigation and Target-side related conversations. Compatibility access follows the existing full-control Workspace Board contract; future conversation-specific visibility must be enforced before exposing those related references.

The tool registry remains explicit. Current Target operations and context tools do not imply that all system capabilities, general HTTP proxies or arbitrary shell commands are available.
