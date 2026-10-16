# ADR 0010: Scoped Delivery Proof Reader

Status: Accepted for local operator-trusted source access; composite proof admission remains separate.

## Context

Delivery-context HTTP routes require Board authority. Independent fact inspection must not give a verifier Board authority, application database administrator credentials, or permission to register proof. Candidate code and supplied JSON are not authoritative observations.

## Decision

The operator provisions a new PostgreSQL LOGIN role and private schema for one active Workspace. Security-barrier views apply fixed Workspace predicates. The role receives SELECT on the enumerated views and no base-table grants or role memberships. Agent configuration, prompts, conversation bodies, API keys and connection credentials are excluded. Selected JSON projections preserve nested values, including nulls, so source receipts retain their canonical meaning.

The role is non-superuser, cannot create databases or roles, cannot bypass RLS, has a two-connection limit and expires after 24 hours. Read-only transaction defaults and five-second database timeouts supplement actual grants; toggling the read-only default does not grant business writes. Provisioning does not adopt existing roles or modify business records, migrations, shared network configuration or existing application grants.

`server/src/services/delivery-proof-reader-build.ts` produces a standalone Node ESM bundle with only Node built-in external imports. Its database surface excludes backup and embedded-database operations. The operator stores the frozen bundle outside the candidate checkout, records its SHA-256 and uses a private owner-only configuration file. The running process receives only its configuration path, not application or Provider credentials. The operator launches it with a sanitized environment.

`server/scripts/delivery-proof-reader.ts` accepts bounded JSON on stdin: `inspect`, or `channel` / `codex` with strict object references. Workspace scope comes only from private configuration. It verifies the actual database identity, scope, expiry, memberships and absence of public-table or public security-definer authority before loading existing delivery contexts. Inspection accepts neither arbitrary SQL nor proof registration. Local logs are read with fixed Workspace paths, bounded sizes, containment checks and change detection. Inspection has a 20-second deadline and returns generic errors without connection details.

The separate v2 view policy exposes a database-computed message body hash and selected runtime-session, repository-binding and connection-state fields without exposing message bodies or application credentials. `channel-provider` uses separately configured private Provider credentials for bounded readback. The optional `prove` mode requires the distinct private signing configuration in [ADR 0011](0011-closed-composite-delivery-proof.md), verifies its own bundle hash and has a 120-second collection deadline. Neither the v1 identity nor ordinary inspection configuration grants that capability.

`server/scripts/provision-delivery-proof-reader.ts` takes Workspace UUID, absolute private config path and absolute local log root as positional arguments. `VERRAIL_PROOF_ADMIN_DATABASE_URL` is supplied privately by the operator to this provisioning process only. Output contains non-secret identity, policy hash and expiry. Failure removes the newly created private access objects. Explicit revocation uses `removeDeliveryProofReader` with the operator identity after stopping reader processes; it verifies the ownership marker, removes only that private schema and role, and leaves application tables untouched. Expiry blocks new authentication; it does not terminate an already established connection, so the per-invocation deadline remains required.

## Trust Boundary

The database administrator and local operating-system owner remain trusted. A same-user local bundle and mode-0400 file are not protection against a malicious host owner, arbitrary candidate processes with that same identity, or database-admin tampering. The credential must not be supplied to an Agent or candidate runtime. No claim of hostile-host isolation follows from a distinct database login.

The role provides scoped source access, not independent verification results. Channel replies still need trusted Provider observation; effective execution permissions and loaded candidate runtime bytes still need their own observations. A reader bundle hash identifies the reader, not the candidate build. Fixed CI association does not expand existing CI assertions. Composite admission requires separate closed validation and domain write authority, and cannot accept this reader's output or hash as a passed proof.

## Verification

Temporary PostgreSQL tests use a real dedicated login, a second Workspace and the existing channel/Codex context services. Refusal coverage includes public tables, secrets, sensitive columns, business writes after disabling the default read-only flag, role escalation, schema changes, scope mismatch, administrator substitution and existing-role collisions. The bundled CLI runs outside the checkout with a clean environment and rejects arbitrary SQL, scope injection, oversized input, symlink configuration and permissive credentials. These tests use synthetic facts and do not claim real Provider delivery or model execution.
