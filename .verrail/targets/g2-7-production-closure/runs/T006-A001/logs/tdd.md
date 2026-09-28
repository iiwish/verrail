# T006 TDD Log

## Red

- Facade tests initially failed because execution did not resolve or transport a connection-bound credential.
- Connector fault tests captured blind-retry gaps for unknown create results, inconclusive lookup, concurrent execution and post-effect receipt failure.
- Execution invalidation tests captured changed parameters, missing Acceptance and a changed Workspace connection binding.

## Green

- The facade resolves one encrypted Secret at execution time and transports it only in two internal headers.
- The Go store records a stable marker and `executing` state before releasing the transaction, then performs lookup/create outside the transaction.
- `unknown_effect` retries always lookup first; found results converge to a unique EffectReceipt and inconclusive results do not create.
- Execution revalidates approval, params, Submission/Revision, Acceptance, commit binding, repo binding and connection identity.

## Refactor

- Provider behavior remains behind the `GitHubClient` port.
- The execution reclaim window uses the PostgreSQL clock, avoiding host clock skew.
- The outbox integration test claims only its own Workspace events; production claims remain unpartitioned when the option is empty.
