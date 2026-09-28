# T004 TDD Record

Run: `T004-A001`

## RED

The first focused shared test run failed two new cases: complete IntegrationRun
bindings were stripped by the old schema and `recordHumanWorkResultSchema` did
not exist. Go integration coverage then exposed an existing graph activation
bug: an omitted dependency list was stored as JSON `null`, so a dependency-free
node never transitioned from `pending` to `ready`.

## GREEN

- Added expand-only migration `0242_bizarre_meggan.sql` with nullable legacy
  IntegrationRun bindings plus new IntegrationAttempt and HumanWorkResult tables.
- Required complete bindings for all new result commands while keeping old rows
  readable with explicit null compatibility fields.
- Added distinct user-or-service result authority for IntegrationRun and retained
  human-only authority for HumanWorkResult.
- Bound node kind, active TargetRevision and GraphRevision, claim criterion,
  active Connection, connector version, commit, environment, provider receipt,
  and authenticated principal in the Go transaction.
- Added strict TypeScript facade validation, OpenAPI registration, and read-model
  projection for attempts and human results.
- Normalized nil dependency lists to `[]` before graph persistence.

Observed GREEN result: a fresh PostgreSQL database applied all 241 migrations;
all Go packages passed uncached, the focused Vitest suite passed 5 files and 38
tests, workspace typecheck passed, migration safety passed, and diff validation
passed.

One reused test database retained outbox rows from an earlier targeted package
run and caused the orchestration isolation test to fail. The required clean-room
rerun used a fresh migrated database and passed; no product code was changed to
hide retained test state.

## REFACTOR

Agent Run creation is now structurally limited to AgentTask execution. Result
commands use a separate authority validator, and both Provider Receipt and Human
result payloads share the same recursive credential-field rejection rule.
