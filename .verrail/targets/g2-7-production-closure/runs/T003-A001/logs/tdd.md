# T003 TDD Record

Run: `T003-A001`

## RED

Go command:

`go test ./internal/target ./internal/httpapi`

Observed result: exit 1. The target package did not compile because
`ValidateCandidateLifecycleCommand` did not exist. The HTTP package compiled,
then both candidate cases failed with 403 instead of 201: Service Submission
and Agent ActionRequest.

TypeScript command:

`pnpm --filter @paperclipai/server exec vitest run src/services/verrail-domain-api-client.test.ts src/__tests__/adjudication-routes.test.ts src/__tests__/connector-routes.test.ts`

Observed result: exit 1. Two candidate route tests failed with 403 instead of
201; the remaining 22 tests passed.

## GREEN

- Added a candidate-only principal allowlist for `user`, `agent`, and
  `service`; the existing lifecycle validator remains user-only.
- Split the transaction entrypoint so only Submission and ActionRequest use
  candidate scope. All other lifecycle store operations fail closed for a
  non-user principal even if called directly.
- Bound idempotency locks, receipts, audit events, Submission authorship, and
  ActionRequest requesters to the authenticated principal type and id.
- Split TypeScript route context into candidate and human contexts. Candidate
  identity comes from `req.actor`; strict body schemas reject identity fields.

Observed result:

- Go target and HTTP packages passed, including PostgreSQL-backed principal
  persistence and one-human governance cases.
- Focused TypeScript suite passed 3 files and 26 tests.

## REFACTOR

Shared workspace/resource/idempotency/hash validation was extracted into one
internal helper. Human and candidate commands retain separate allowlists,
messages, and rejection codes.

