# ADR-0009: Phased Criterion Proof

Status: Accepted

## Contract

An optional `proofContract` v1 on each immutable TargetRevision criterion contains mandatory `allOf` requirements. Independent verification fixes its assertions and either the `pre_acceptance` or `post_effect` phase. Human governance is evaluated after genuine Review, ActionApproval and Acceptance records exist for an Agent/Service candidate and requester. Pull-request effect proof resolves a real, parameter-bound EffectReceipt. These sources are not interchangeable. A compound recovery and secret-handling requirement retains every assertion.

Legacy criteria retain pre-Acceptance independent verification. Missing fields stay missing in serialized historical objects; existing hashes are not rewritten. Candidate Acceptance requires only current pre-Acceptance proofs and an independent approved Review. Final Outcome requires every requirement, the complete active graph, valid Acceptance and settled required effects.

## Persistence And Authority

An authenticated human revision command uses an expected TargetRevision and an idempotency key. It preserves criterion identities, text, owner and every other responsibility field, appends a revision, and detaches the old active graph in a domain transaction. New graphs and runs bind the new revision through existing commands. Historical nodes, runs, candidates and decisions are not retagged. A target without a new active graph cannot be complete.

CriterionProof stores an immutable context binding to an independent VerificationResult, including the complete proof-contract hash, TargetRevision, GraphRevision, criterion and requirement. Post-effect bindings also identify the Submission and EffectReceipt. The source verifier records actual assertion coverage; typing assertion names in the UI is not verification. Integration ingestion atomically persists this binding with the existing Evidence and VerificationResult, rather than copying a CI result into an unrelated result identity.

Pre-Acceptance selectors exclude post-effect results. Adding a late failed or inconclusive result blocks final Outcome without rewriting the immutable Submission or invalidating its otherwise current earlier Acceptance. New candidate, graph, target, parameter or effect identities require their own proof. The UI exposes proof stages, facts and gaps without granting decision or effect authority.

Contract-bound IntegrationRun ingestion is restricted to authenticated internal verifier services. The collector must independently fetch and verify the actual Provider run and attempt identity, commit, assertion coverage and verification time; the domain validates the context but does not perform that network verification. The Provider receipt includes `criterionProof` with the contract hash, requirement ID, exact assertions, TargetRevision, GraphRevision, commit, verification time, stable `providerRunId`, positive integer `providerAttempt`, and applicable Submission/EffectReceipt IDs. The contract hash uses SHA-256 over recursively key-sorted JSON with Go JSON string escaping. A neutral contract-bound result creates an `inconclusive` VerificationResult and blocks its verification node; legacy neutral results remain evidence-only.

Provider source identity binds Workspace, Connection, Provider run and attempt, TargetRevision, GraphRevision, criterion and proof context. It excludes command keys, ingestion time, verification time and mutable receipt payload. A unique immutable source binding returns the original IntegrationRun for an identical input under a fresh command key, without adding Evidence or changing node status; contradictory input for that source conflicts. A genuinely new Provider run or attempt appends new proof, so failure and inconclusive evidence cannot be erased by replaying an older passing source. A separate input hash checks replay consistency, not source identity. Nullable source columns preserve historical rows without inventing Provider identities; all contract-bound ingestion supplies both hashes.

Revision commands refuse unsettled external actions and active Runs. Existing Run terminal/fencing guards and Graph expected-version checks remain authoritative; the revision does not relabel or transfer their outputs.

## Deployment And Rollback

Apply additive schema migrations before deploying the synchronized shared, Go, TypeScript and UI contracts. No historical backfill or destructive down migration is required. Do not run an older evaluator against targets with explicit proof contracts: it does not understand the new requirements. Roll back application traffic only to a version that preserves these contracts, or disable affected mutation paths while retaining facts for inspection.
