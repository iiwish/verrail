# T020 TDD Log

## RED

The serialized `pnpm test:run` gate failed in `connector-routes.test.ts`: the HTTP fixture omitted `params.body`, while the shared validator deliberately normalized it to `body: ""` before Domain API dispatch. The test compared those two different contract stages as if they were identical.

## GREEN

Kept the body-less HTTP fixture and added a focused normalized fixture for the downstream expectation. The connector route suite passed all 16 tests.

## REFACTOR

No production code changed. The two helpers name the wire and post-validation representations without duplicating unrelated command data.
