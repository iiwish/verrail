# ADR 0016: Repository Run Execution

Status: Accepted contract; end-to-end deployment acceptance is separate.

## Decision

Server-side repository work is a Target Run, not a ConversationInvocation or an
inherited Heartbeat. The Go Graph Engine retains activation, attempt, lease,
fencing and terminal artifact-registration authority.

The `repository_sandbox` runtime profile is paired exclusively with the service
principal `verrail-repository-runner`. Command validators and database constraints
enforce both directions of this pairing. The host executor and host proof readers
retain their `host_trusted` gates. A profile name alone does not attest isolation.

Temporal Worker selects the profile with `VERRAIL_EXECUTOR_RUNTIME_PROFILE` and
the service identity with `VERRAIL_EXECUTOR_PRINCIPAL_ID`. Defaults are
`host_trusted` and `verrail-host-runner`. Repository scheduling requires explicitly
setting both to the repository pair; invalid pairings fail during configuration
loading, before database or Temporal connections are opened. Setting these values
does not install or admit a repository executor.

The Domain API, control plane, and Temporal Worker share the same
`VERRAIL_EXECUTOR_RUNTIME_PROFILE`. In repository mode, the Domain API rejects
an unbound Run before inserting it or consuming its ready node. The control
plane exposes `repositorySourceRequired` to disable Start until the selected
source matches the current workspace, Target revision, and graph revision.
An unset profile preserves the explicit HostTrusted development path.

In `repository_sandbox` mode, ready agent nodes wait for an explicit source-bound
Run command. The Target scheduling cycle does not create unbound Runs or select
the latest source artifact. A human selects the immutable provenance revision
when creating the Run; its outbox event starts the normal Run workflow and
attempt allocation. `host_trusted` retains automatic Run creation. Historical
unbound Runs are not rebound or retried automatically.

Repository admission distinguishes offered/pending, claimed/pending and running
states. The executor reports claim and start through the Go event protocol and
revalidates identity, active graph, cancellation and lease authority between
transitions. A pending attempt cannot pass the running command gate. Ambiguous
transition responses stop dispatch rather than authorize speculative execution.

`verrail_repository_dispatches` is TypeScript execution-controller transport
state, not a Run fact table. A RunAttempt has at most one dispatch intent. The
controller commits the complete validated input hash and controller identity
before harness invocation. An existing intent never grants permission to invoke
again, even for identical input. Expired controller ownership cannot be renewed.
Recovery must report uncertainty rather than replay repository modifications.

The dispatch record admits at most 20 repository tool calls. Admission increments
the counter transactionally while locking the associated Run, Attempt and Lease,
and validates current execution authority. The full request hash and controller
ownership are checked on callbacks. Transport results still require Go-owned
fenced event reporting; a transport status alone is not Run completion.

The execution input binds Workspace, Target revision, Graph revision, WorkNode,
Run, RunAttempt, ExecutionLease, fencing token, AgentVersion and DeploymentRevision.
Repository input is a content-hashed Git bundle and an exact base commit, not an
arbitrary server path or a model-selected clone URL. Each attempt gets a disposable
checkout. Repository commands have no external-action authority. Git push and merge
require their own governed action path and are not implicit output submission.

The first release takes source from the workspace's authorized GitHub repository
binding. A trusted acquisition component validates the active connection, resolves
the selected revision to an exact commit and produces the immutable bundle. Source
provenance binds the repository identity and resolved commit to the Target input;
later branch movement cannot change an admitted attempt. Missing or revoked
authorization prevents source admission. GitHub credentials are acquisition-only:
they must not enter the harness environment, checkout configuration, execution
packet, logs or output artifacts. A manually supplied bundle is a test fixture,
not the product's repository selection workflow.

Trusted acquisition uses a temporary bare repository, an explicit commit refspec,
disabled credential helpers and redirects, and an ephemeral HTTPS authorization
header. No checkout or repository hooks run in the acquisition process. The
resulting bundle is limited to 32 MiB, and its selected tree passes the executor's
file/type/expanded-size checks. Fetch and pack generation also require an enforced
scratch-volume quota in the deployment: a post-generation bundle limit does not
bound transient downloaded history or pack expansion. Acquisition requires an
explicit Linux tmpfs scratch directory owned by the process user with mode 0700
and filesystem capacity at most 512 MiB. It rejects symlinks and unbounded or
non-tmpfs storage before credential resolution. Git HOME and TMPDIR are inside
that scratch area. Release Compose must provide and verify this mount before
enabling source acquisition in the scheduler.

Each trusted Git command has a 120-second execution deadline. Cancellation,
output overflow and deadline expiry enter a bounded cleanup window that requires
both closed process pipes and confirmed process-group absence. Unconfirmed
cleanup rejects acquisition and retains its private scratch directory; operators
must confirm the owned process group is gone before removing retained scratch.
No bundle is admitted on this path.

The harness uses scoped repository tools. It does not receive control-plane
credentials or direct shell access outside the command sandbox. Runtime completion
must wait for child-process cleanup. Cancellation and authority loss prevent output
registration; cleanup uncertainty must not be presented as successful cancellation.
The server command backend is the disposable container boundary defined in
[ADR 0017](./0017-disposable-repository-command-containers.md), not a
Landlock-dependent process launcher inside the credential-bearing controller.

After confirmed cleanup, the current dispatch owner can persist a `canceled`
transport receipt only while the current Attempt has a cancellation request and
its matching fence and lease remain valid. The controller sends a distinct,
idempotent `terminated` event using the persisted event cursor. Go validates
execution authority and atomically cancels the Run and Attempt and releases the
lease. The recovery worker can retry delivery from that durable receipt without
invoking the harness again. An expired lease, lost ownership or uncertain cleanup
does not authorize a cancellation receipt or a successful terminal claim.

Uploaded bytes are content addressed. Upload success alone does not make the Run
successful, publish a Submission or grant acceptance. Registration must still pass
the current fenced Run contract with immutable source and output provenance.

A Run can bind `repositorySourceRevisionId` when created. The Go transaction
records the selected provenance ArtifactRevision in `verrail_run_sources`, with
workspace-scoped foreign keys to both Run and ArtifactRevision. Reusing the Run
idempotency key with a different or omitted source is a conflict. The selected
revision must belong to a report in the same Target. This reference pins input;
it does not prove the report's source manifest is valid. Repository execution
must validate its content hash, Target/Graph identities and referenced bundle
before admitting commands. The binding is not a grant to fetch or modify GitHub.

The Linux repository execution entrypoint requires this binding before claiming
an attempt. It reads only the Run-selected provenance revision from canonical
content-addressed storage, bounds the manifest to 64 KiB, verifies its hash and
Target/Graph identities, and matches the requested commit and bundle to the exact
registered source ArtifactRevision. Missing bindings fail closed. Lease and
command authority remain separate checks after source validation.

## Release Gate

The first private release requires actual Target repository edits and inspectable
artifacts. Conversation tests, standalone harness tests and profile constraints
are necessary but insufficient evidence. The assembled container path must prove
source isolation, command restrictions, authorization and budget enforcement,
cancellation, restart recovery and fenced artifact registration. Current maco
platform and project preflight gates remain required. COS backup is not a maco
deployment gate; current recoverability must not be claimed without evidence.
