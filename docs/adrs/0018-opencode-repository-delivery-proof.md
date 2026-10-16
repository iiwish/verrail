# ADR-0018: OpenCode Repository Delivery Proof

Status: Accepted

Date: 2026-10-16

## Decision

`opencode_execution` is a separate closed composite proof kind. It covers exactly
the OpenCode execution and fixed-CI assertions in `DELIVERY_PROOF_ASSERTIONS`.
It does not relabel a Codex heartbeat, copy a historical proof, admit a partial
assertion set, or authorize human governance or an external action. The existing
Codex and Feishu kinds retain their native source and runtime contracts.

The private operator-installed verifier uses an explicitly versioned scoped
database reader and a read-only content-addressed storage capability. Requests
select existing Run, Attempt, Claim, integration node, requirement and source
ArtifactRevision. They cannot supply execution facts, permissions, usage,
candidate identity or a verdict. Missing optional observer configuration permits
ordinary execution but cannot produce closed OpenCode proof; invalid configured
observer state fails closed.

## Execution And Source

Repository execution produces its own typed output receipt. The receipt binds
the complete parsed request, input provenance revision, Workspace, Target and
graph revisions, node, Run, Attempt, lease, fence, AgentVersion and
DeploymentRevision. The receipt is finalized only after runtime, command, private
HOME and checkout cleanup. Code and ordinary file outputs retain explicit types;
only exporter-generated source snapshots can prove product-source equivalence.

The trusted runtime stores the exact bounded OpenCode session history separately
from model-selected artifacts, and stores a content-addressed execution
observation. Private history is limited to 2 MiB and the observation to 64 KiB.
The verifier reads and hashes both objects, replays the fixed HTTP response
parser, validates complete session step usage and checks the before/after
permission and environment readbacks. Incomplete, truncated, foreign-session or
changed observations do not produce proof.

OpenCode's reported price is an estimate, not verified billing. The recorded cost
status is `unavailable` with an explicit estimate basis; missing pricing is not
free execution. Paid execution requires a separately enforced spending allowance.
HTTP permission readback is not OS sandbox or data-egress attestation.

The source reader checks actual input and output storage bytes, the bound source
provenance, the latest successful repository Attempt, released lease, durable
dispatch, exact terminal result and unique artifact-registration audit. The
fixed GitHub workflow is read independently and its tested product-source tree
must match the exported source snapshot. GitHub does not attest OpenCode runtime
facts; the composite proof provider is `verrail`.

## Independent Runtime Witnesses

The pinned manifest covers the Server, Go Domain API, repository executor and
OpenCode executable. Node observers inspect loaded V8 source against the fixed
source manifest. The OpenCode observer cold-launches a private immutable native
executable and independently reads its HTTP health, session identity and private
working directory. Parent IPC binds the actual native and observer PIDs to the
full repository execution identity and manifest session.

Long-lived witnesses cover the complete execution window and respond to fresh
private checkpoint nonces. OpenCode is a server: its controlled shutdown is
recorded as a requested signal with independently confirmed process-group
termination and executable-copy removal, not a fabricated normal exit code.
Missing native cleanup or an identity/window mismatch rejects collection.

The reader verifies complete signed witnesses before projecting compact summaries.
Exact signed envelopes remain in private, content-addressed, single-link,
read-only archives. Summaries retain identity, time, configuration, source manifest,
observation hash and archive hash/reference. They do not include thousands of
loaded script entries in the closed 40 KiB observation. Go trusts the configured
closed verifier's signature for this collection; Go does not read the local
archives or independently repeat the inner runtime signature checks.

This remains HostTrusted provenance. It does not isolate hostile same-UID code,
attest native shared libraries or every Node child/thread, or establish arbitrary
descendant containment. Private keys and observer configuration are not injected
into the model's runtime environment.

## Admission And Compatibility

The existing bounded closed-envelope transport and immutable startup trust profile
remain in force. Go strictly decodes the OpenCode observation, including required
nullable fields, rejects unknown or duplicate fields, checks identity and temporal
bindings, and revalidates the repository dispatch and source in the admission
transaction, including on replay. A correctly signed empty observation is invalid.

Successful admission writes the IntegrationRun, two distinct Evidence records
(`scan_result` and GitHub `ci_result`), one VerificationResult, CriterionProof,
command receipt and audit atomically. The generic integration endpoint and normal
service bearer do not gain this capability. Existing Codex/Feishu reader policies,
hashes and source requirements are not recomputed under the repository contract.

Database checkpoints, a service restart, a synthetic fixture and a backup restore
are not repository recovery proof. Recovery uses the independently authenticated
interruption and reconciliation contract in
[ADR-0019](0019-repository-recovery-delivery-proof.md). This ADR does not declare
a candidate tested, an image deployed, a recovery drill completed or a human
decision made.
