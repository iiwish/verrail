# ADR 0017: Disposable Repository Command Containers

Status: Accepted implementation direction; deployment acceptance is separate.

## Decision

Repository execution separates trusted orchestration from untrusted repository
commands at a container boundary. The seven long-running services remain in
place. `repository-executor` is the trusted controller: it retains model access,
Go event reporting, lease/fence validation and artifact registration. It never
executes repository commands in its own container.

Each admitted command gets a separate, short-lived Docker container. Only that
attempt's checkout is writable. It has no database credentials, internal token,
model credential, shared artifact directory, Docker socket, or application network.
Its image is operator-pinned, its root filesystem is read-only, and it runs as
UID/GID 1000 with all capabilities dropped, no-new-privileges, Docker's default
seccomp policy, bounded CPU/memory/PIDs, and `network=none`.

Landlock ABI 6 is not a prerequisite for this backend. Container isolation still
depends on the host's supported Docker/kernel security facilities and does not
claim protection against host administrator compromise or kernel vulnerabilities.
The optional legacy Landlock launcher is not the release executor's backend.

## Restricted Operations Gateway

The controller uses a dedicated, pinned-host-key SSH identity restricted to the
`verrail-container-v1` protocol. The root-owned operations helper accepts only
`start`, `poll` and `stop` for UUID command identities. There is no generic exec,
Docker API forwarding, caller-selected image, mount, environment or network.
The account has no general shell, forwarding, Docker group or general sudo
authority; its forced command may invoke only the fixed root-owned helper with
no arguments. Neither project services nor command containers mount Docker's
socket. The existing host SSH service is an operations transport, not another
application service.

Operator policy fixes the project, immutable command image, private state root
and bounded checkout root. Checkouts reside on a dedicated, at-most-512-MiB
tmpfs under the registered project data directory, shared with the trusted
controller. The helper anchors the selected checkout with an open directory
descriptor and a root-owned temporary bind mount before Docker mounts it, so a
changed pathname cannot select another host directory. The temporary host mount
is removed after container startup and during stop recovery; unconfirmed unmount
also prevents cleanup acknowledgement. The controller can execute commands in its admitted checkouts,
not grant arbitrary host filesystem access.

## Lifecycle And Authority

Go remains the only authority for Runs, Attempts, leases, fencing, terminal
events and ArtifactRevision registration. Existing workspace admission, source
binding, command budget and authorization checks occur before command dispatch
and after completion. The gateway cannot mint any of these business facts.

Gateway start records are durable before engine creation. Reusing an identity
with different input is rejected. An ambiguous creation is not retried as a new
execution. Stop records a tombstone, removes only the owned container and checks
its absence through a functioning Docker daemon before acknowledging cleanup.
An engine or SSH failure is not evidence that processes stopped.

Every command has a hard container-local deadline, at most 120 seconds, which
continues if the controller or SSH connection disappears. The namespace's PID 1
exiting terminates all remaining command processes, including detached children.
Normal completion also requires container removal before checkout collection.
The controller always sends stop with an independent cleanup deadline, including
after a lost start response. Cleanup uncertainty retains the existing unresolved
dispatch behavior; it cannot produce a successful cancellation receipt.

Successive commands share the attempt checkout, not a process namespace. A Run
still uses at most 20 commands, and command output remains bounded. Gateway
records are transport tombstones/results, not execution or acceptance facts.
They must be retained across controller restarts; cleanup of records is an
operator retention task, never an automatic reason to replay a command.

## Deployment And Verification

Installing the forced-command identity and operations helper requires explicit
operator authorization. Do not automatically reconfigure SSH, sudo, Docker or
host mounts from an application container. Scratch mounting is a project-scoped
operations prerequisite; absence after reboot fails startup rather than falling
back to an unbounded directory. The Docker command image and helper hashes are
part of deployment evidence.

Acceptance requires real Docker tests for secret/network/filesystem boundaries,
execution and output limits, detached-child cancellation, repeated/ambiguous
starts, controller disconnect, and cleanup acknowledgement. Full Go/Temporal
repository acceptance is separate from gateway tests. An unconfigured gateway
does not justify a host-shell or legacy-launcher fallback.
