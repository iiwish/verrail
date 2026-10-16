# ADR-0019: Repository Recovery Delivery Proof

Status: Accepted

Date: 2026-10-16

## Decision

`repository_recovery` is a separate closed composite proof kind for the complete
four-clause assertion set in `DELIVERY_PROOF_ASSERTIONS`. It combines the OpenCode
execution and fixed-CI obligations with an independently authenticated executor
interruption, same-Attempt reconciliation, duplicate reconciliation, and actual
older-Attempt fencing rejection. A subset of these clauses cannot enter this kind.

The covered interruption point is precise: the repository dispatch has a durable
successful result and verified runtime, command and private-directory cleanup,
but its terminal Run event and Artifact registration are not yet complete. The
observer stops the old executor and starts the same candidate and configuration.
The new executor reconciles the existing result on the same Run and Attempt,
without invoking a model or creating another execution dispatch.

This is not recovery from an interrupted model session, a database rollback,
power loss, an arbitrary escaped descendant, or a full-host disaster. These need
their own contracts and observed evidence.

## Authorities And Inputs

The operator installs a build-pinned private reader with V4 workspace-scoped,
read-only database views and a read-only content-addressed storage capability.
V4 includes the selected execution command receipt fields needed for independent
fencing correlation. Older reader policy hashes and views retain their meaning.

The reader and lifecycle observer use separate Ed25519 signature domains. Their
private configuration pins candidate and manifest identity, executable/build
hashes, session and execution identity. The observer verifies its own Node and
entrypoint bytes. The executor enables recovery-only IPC only with the complete
private configuration and an actual Linux parent executable/argv/build readback.
Unconfigured executors retain their ordinary lifecycle; invalid configured
recovery state fails closed.

Private CLI commands select existing versioned objects only:

- `recovery-authorize` selects the Run and Attempt before registration.
- `recovery-probe-authorize` selects the recovered candidate and an actual older
  Attempt from the same Run.
- `recovery-complete-authorize` selects the same recovered candidate after the
  two fixed probes.

Caller input cannot provide commands, filesystem paths, credentials, runtime
observations, a fencing token, a fabricated earlier Attempt, or a verdict. The
reader obtains those facts from trusted configuration and actual scoped state.
The commands do not grant the reader general database or execution-write authority.

## Authenticated Recovery Protocol

1. The observer launches the old executor and publishes its actual process birth
   and loaded-source checkpoint. While that process is alive it can also publish
   the normal repository-executor witness for the OpenCode proof manifest.
2. The reader verifies the complete OpenCode history, permission/environment
   readbacks, typed output receipt, stable before-registration DB/storage state,
   and all four independently signed runtime witnesses. It signs an authorization
   containing a fresh lifecycle nonce, the entire pre-runtime proof hash, exact
   ready/witness hashes, before-state hash, and a bounded validity window.
3. The observer permanently stops old-stage normal witness publication, binds the
   authorization to its last actual witness, verifies known detached runtimes are
   gone, and stops/reaps the old executor. It launches the same configuration and
   publishes the new process birth and loaded-source checkpoint. A new process
   cannot answer a fresh normal-runtime nonce on behalf of the stopped process.
4. After the new executor has registered the durable result, the reader captures
   the full recovered result and the actual older/current Attempt, lease and
   history fingerprints. It signs authorization for two fixed operations.
5. The observer issues duplicate reconciliation and then a payload-free stale
   heartbeat through its launch-owned executor IPC. Each request has a fresh
   observer-generated challenge and bounded lifetime. Signed journals contain
   the actual canonical IPC request and typed response bytes, hashes, byte counts,
   and before/after process/source checkpoints. They do not claim to be raw HTTP
   response bytes.
6. The reader verifies both journals, the real stale-fence command receipt and
   unique audit, actual non-replayed response, receipt/audit time windows, and
   unchanged recovered result and older/current state. Two stable reads alone
   are not evidence that reconciliation ran. A stored receipt's original
   `replayed: false` is not evidence that the current invocation was fresh.
7. Only then does the reader authorize a final new-process checkpoint and stop.
   The observer requires the exact probe hashes, confirms process-group absence
   and reap, and signs the terminal lifecycle observation. Any unresolved cleanup
   or missing signature prevents a successful proof.

The older Attempt must be real, earlier, version-compatible, and failed or
superseded, with an expired or revoked lease and accepted initial event history.
The probe uses its actual lease, fencing token and next cursor. The current
Attempt must remain the successful latest Attempt with a released lease.

## Archives And Admission

Full before/probe/after records and signed envelopes are immutable private
content-addressed files. Publication is atomic and refuses overwrites; readers
reject noncanonical paths, symlinks, extra hardlinks, wrong ownership, writable
archive files, oversized bytes and content-hash mismatches. Full runtime witnesses
retain their separate verified archive references.

The closed observation contains an unchanged strict `opencode_execution`
component and a compact recovery summary. The summary binds process births,
candidate/configuration/source hashes, checkpoint hashes, actual stop outcomes,
probe journals, stale-fence receipt/audit and complete private archive references.
The existing bounds apply independently: `ObservationJson` is at most 40,000
bytes, the envelope's base64 `Payload` is at most 60,000 characters, and the outer
transport is at most 65,536 bytes.

The final reader entry rechecks the active TargetRevision, GraphRevision, complete
requirement, Claim and scoped integration node. It reads the actual post-recovery
execution history and source, matches them to the authenticated pre-interruption
facts, and independently reads fixed CI and its source mapping. Historical
pre-runtime witnesses are used only through this authenticated lifecycle chain;
normal OpenCode proof collection retains its fresh-nonce requirements.

Go strictly decodes both components, checks their identities and temporal
bindings, and rechecks source, dispatch, current/older execution state and actual
rejected command/audit associations in the admission transaction. Complete row
fingerprints cover the current and older Attempt, lease and event history, the
current Run, rejected command receipt and audit, authoritative result, and every
output ArtifactRevision with its parent Artifact metadata. The trusted
reader signature authenticates private archive and journal verification; Go does
not read local private files itself. Successful admission uses the existing
atomic IntegrationRun, Evidence, VerificationResult, CriterionProof, command
receipt and audit path.

Complete database state fingerprints use the versioned
`verrail.repository-recovery-db-state.v1` type-tagged encoding, with UTF-16 key
ordering, finite IEEE-754 numbers, normalized negative zero and a 16 MiB encoded
state limit. Timestamp columns retain the reader's UTC millisecond projection;
JSON payload keys are not renamed. Other proof and checkpoint hash protocols
retain their own encoding contracts.

## Limits And Release Evidence

The observer directly checks only the known OpenCode observer/native detached
groups. Command cleanup is the pinned candidate executor's verified stop-ack
receipt basis, not independent Docker/cgroup inspection or proof of every escaped
process. HostTrusted provenance does not isolate malicious same-UID code.
OpenCode cost estimates remain unverified billing, and HTTP permission readback
does not become OS isolation.

Implementing and testing this contract does not establish that a particular
candidate passed a real Linux recovery drill. Deployment requires that observed
drill and the final candidate's CI, image and operational evidence. No synthetic
fixture, backup restore, service health check, or signed empty observation replaces
it. DeliveryReview, ActionApproval, Acceptance and external EffectReceipt remain
separate, identity-bound obligations.
