# T009 TDD Log

## RED

- The plugin contract had no versioned enterprise-channel port or typed webhook result.
- Provider replay and concurrent delivery had no durable claim independent of message metadata.
- The public plugin route could persist delivery metadata before Feishu authentication.
- Ordinary provider messages and explicit Target creation were not separated by an authorized local-human mapping.

## GREEN

- Added Channel Connector V1 types, validators, plugin manifest declarations and worker RPC dispatch.
- Added Feishu signature, encrypted payload, verification-token and app-id checks plus URL challenge, inbound message normalization and idempotent reply transport.
- Added the Workspace-scoped durable event inbox and atomic Host ingestion for group/direct binding, one message and optional draft.
- Moved public-route delivery persistence after authentication and forwarded only the declared signature headers.

## REFACTOR

- Kept Feishu payload parsing, identifiers and provider transport inside the plugin.
- Made the Host consume a small provider-neutral message contract and generate deterministic UUIDs from structured tuples.
- Persisted only normalized facts and the minimum provider receipt required for replay safety.

## Verification Note

Focused contract, adapter, route and real-PostgreSQL suites passed. The full Vitest run passed
2,894 assertions but emitted one environment startup rejection because the embedded-postgres
meta package references an unpublished Darwin native beta. The isolated affected suite passed
after a local compatible payload repair; the complete suite remains a T010 closure gate.
