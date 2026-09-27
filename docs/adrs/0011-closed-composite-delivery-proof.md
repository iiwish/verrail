# ADR-0011: Closed Composite Delivery Proof

Status: Accepted

Date: 2026-09-10

## Decision

Composite pre-acceptance proof uses a separately installed, operator-configured
local verifier. Its closed kinds are `feishu_target` and `codex_execution`.
Each kind covers exactly its two complete assertions in
`DELIVERY_PROOF_ASSERTIONS`; partial clauses, extra assertions and post-effect
obligations are unsupported. The GitHub fixed-CI verifier retains its four CI-only
assertions and cannot issue either composite kind.

The verifier runs from a fixed bundle outside the candidate checkout. Its private
configuration pins the Workspace, current Target/Graph revisions, GitHub policy,
reader policy, verifier build, runtime manifest and Ed25519 key. Requests contain
object references and an idempotency key, not verdicts or observations. Provider
credentials and the signing key are not forwarded to the candidate runtime.
The scoped v2 database identity provides read-only facts; its 24-hour expiry is
not extended by verification. Ordinary inspection configurations carry no signing
capability.

## Collection

- Feishu verification independently reads the inbound message and creation reply
  from the configured Provider. It checks the authorized user mapping, body
  hashes, conversation, reply parent, sender and timestamps against the confirmed
  Draft, creation command, TargetRevision and reply receipt. Callback identifiers
  remain correlation references, not a replay of the original callback signature.
- Codex verification checks the exact Run/Attempt, AgentVersion, DeploymentRevision,
  version-bound selected permission configuration, recorded API permission probes,
  log bytes, usage/cost provenance and finalized native output receipt. The API
  probe origin must match the pinned runtime manifest. The Harness witness binds
  the Workspace, Agent and heartbeat Run actually supplied to the launched process.
- Both kinds independently read the fixed GitHub workflow, jobs and report archive,
  and map the tested commit's product-source tree to the authoritative native
  source ArtifactRevision. The v2 root `.verrail` exclusion is unchanged. Existing
  CriterionProof rows are not prerequisites or substitutes for collection.
- Database authority, source associations and binding fingerprints are rechecked
  around external reads. Missing, changed or unavailable facts produce no proof.

## Runtime Witnesses

An operator-pinned manifest binds the candidate commit, API origins, plugin
identity and the configuration/build hashes of Server, Domain API, Plugin and
Harness observers. A launch-owned proxy preserves the real process's stdio and
Plugin IPC. The selected Plugin worker uses that proxy in its actual host fork
path; an unrelated observer process does not replace the worker.

For Node processes, the observer hashes source returned by the process's V8
debugger. Unknown scripts and sourceURL impersonation are rejected. Generated
scripts require an explicit source-hash allowlist in the pinned configuration;
observed unknown code is never automatically added to that allowlist. For native
processes, the observer cold-starts a private immutable executable copy and
checks its identity before producing a witness. Native Harness arguments are
fixed by configuration, and the proxy preserves the child's exit status.

Node checkpoints require an actual debugger pause at a JavaScript statement.
An idle event loop that executes no JavaScript within the checkpoint deadline
fails closed with no witness; a pause acknowledgement alone is not evidence.
Acceptance fixtures include a lightweight, unreferenced periodic callback in
their manifest-hashed source. The observer does not inject code to wake an idle
candidate or relax the source allowlist.

Long-lived service witnesses are freshly requested and cover the source window.
A native Harness can finish before output registration: its separately signed
terminal witness records executable identity, execution identity, times and exit
status. It must report a successful, unsignaled exit overlapping the source
execution window, with a bounded completion allowance. Historical source rows
without a matching runtime session and execution identity cannot be upgraded.

This is HostTrusted provenance. It does not isolate malicious same-UID processes,
attest native shared libraries, attest every Node child/thread, or establish OS
filesystem/network isolation. The operator reviews build provenance and the
manifest; a candidate-authored on-disk version stamp is not a runtime witness.

## Admission And Storage

Go enables `POST /v1/workspaces/{workspaceId}/delivery-proofs` only with
`VERRAIL_DELIVERY_PROOF_TRUST` or the mutually exclusive absolute
`VERRAIL_DELIVERY_PROOF_TRUST_FILE`. The file form lets the pinned runtime
configuration reference a public startup profile without a self-referential
manifest hash. Configuration is snapshotted at startup. No private signing key is
configured in Go.

The envelope signs exact payload bytes with the domain separator
`verrail.closed-delivery-proof.v1`. Go checks the configured key, profile/build/
reader/runtime hashes, Workspace, exact revisions, candidate and freshness. The
maximum request is 64 KiB. A normal Domain API bearer or supplied Principal cannot
grant this authority. Signed observation JSON and its byte hash remain inspectable
in the Provider receipt.

The dedicated verifier rechecks the source and active contract under domain
transaction locks, including before replay. It atomically writes an IntegrationRun
with Provider `verrail`, a `scan_result`, the linked GitHub `ci_result`, a passed
VerificationResult, CriterionProof, command receipt and audit. The generic
IntegrationRun endpoint remains GitHub-only and cannot admit explicit proof
contracts. The database Provider constraint permits `github` and `verrail` without
changing existing GitHub records.

The private verifier persists the issued envelope before submission. Retrying
the same request reuses that exact signed envelope; changing references under
the same key is rejected. Expired envelopes cannot refresh themselves. Failed
verification creates neither a fabricated negative proof nor an Acceptance.
