# Maco Container Build Components

These are candidate build and Compose components, not an approved release.
`compose.yaml` and `deploy/maco.json` declare seven services and three one-shot
jobs. Image variables require operator-supplied verified digests; no release
digest set is frozen. Durable invocation routes require explicit gateway
configuration. An authenticated application/OpenCode fixture verifies scoped
tools, persisted replies and cancellation against a local provider simulator.
Full-stack and real-provider acceptance remain incomplete.

The authenticated Target source preparation endpoint accepts a Git ref plus
current Target/Graph revision identities. It uses the workspace's authorized
GitHub binding, pins the commit and registers bundle/provenance artifacts for Run
binding. Caller-supplied repository URLs and credentials are rejected. One source
acquisition runs at a time per control-plane process, with a four-minute request
deadline and cancellation on disconnect. The control plane has Git and a private,
non-executable 512 MiB tmpfs at `VERRAIL_REPOSITORY_SOURCE_SCRATCH`; no acquisition
checkout or Git credential is mounted into the repository executor. Browser
source selection and assembled container acceptance remain incomplete.

`Dockerfile.control-plane` is the external-database-only Node build candidate.
It retains the frozen-lockfile workspace installation and the repo's TS package
loader, and removes native PostgreSQL, PGlite and bundled Codex packages from the disposable
image output. It does not use pnpm 9 deploy, which permits dependency resolution
during packaging. It installs no global harness CLI and refuses startup without
external PostgreSQL credentials. Its local image smoke verifies production
application/migration imports and UI assets after pruning; authenticated container
startup against PostgreSQL remains a gate. Dependency footprint optimization is
not a release-proof shortcut.

`Dockerfile.temporal` wraps digest-pinned Temporal server and administration
binaries. `temporal_runtime.py` uses separate `verrail_temporal` and
`verrail_visibility` schemas in the same registered project database. Runtime
and migration modes receive separate credential mounts; neither creates a
database. Schema ownership/default grants must be prepared by the project
migration job. A local PostgreSQL 17 container fixture verifies repeated schema
migration, runtime-role server health and repeated namespace creation. This fixture
uses an internal disposable network, never maco or an existing application DB.
It does not establish production capacity, recovery or full application health.

Startup order is application migration and grants, Temporal schema migration,
Temporal health, namespace creation, then orchestration. The control plane waits
for Domain API, gateway health and namespace creation. Worker health checks both
PostgreSQL and Temporal with a bounded deadline. The gateway has neither shared
database network membership nor database credentials. Only the control plane
publishes a loopback port (3271 by default).

The application migration job validates the dedicated migration role and database
owner, serializes jobs with an advisory transaction lock, applies repo migrations,
and grants runtime DML and read-only migration history access. Runtime DDL
authority fails the job. Temporal and visibility use separate custom schemas;
default grants cover tables created by subsequent Temporal migrations. Proposed
runtime pool allocation is Node 6, Domain API 2, worker 2, repository recovery 1,
repository executor 1 and Temporal at most 8 (20 total);
the registered 20-connection aggregate budget still requires live verification.

`Dockerfile.domain` builds the Domain API and orchestration worker from the same
source. Supply reviewed digest-pinned GO_IMAGE (Go 1.26-compatible) and
RUNTIME_IMAGE (Debian-compatible). The default command is domain-api; override it
with orchestration-worker for the worker image/container. Configure its internal
listen address explicitly. Neither image provisions a database.

`Dockerfile.opencode` requires a Debian-based NODE_IMAGE and an exact
OPENCODE_VERSION. Release image identity is the built digest, not the build tag.
It bundles the private execution gateway, protected by VERRAIL_GATEWAY_TOKEN_FILE.
VERRAIL_GATEWAY_PROVIDERS_FILE contains the operator-controlled provider JSON;
VERRAIL_CONTROL_PLANE_URL identifies the internal control-plane callback origin.
Both files must be absolute, regular, non-symlink mounted files and not readable
by others. The gateway spawns a separate loopback-only OpenCode process with
temporary HOME/XDG directories and generated Basic authentication per invocation.
Only the six approved Director tools are offered to that process. This isolation
is not a sandbox for arbitrary code execution or untrusted provider plugins.

The entrypoint holds a nonblocking exclusive flock on the persistent
VERRAIL_GATEWAY_ROOT (default /var/lib/verrail-gateway). The volume must be private
and owned by UID 1000. Interrupted records fail on restart rather than rerunning
effects. Run the container with an init process and sufficient stop grace time
for process-group cleanup. Port 4096 is an internal service, not public ingress.
The control plane uses VERRAIL_EXECUTION_GATEWAY_URL, VERRAIL_GATEWAY_TOKEN_FILE
and a separate VERRAIL_DIRECTOR_SIGNING_KEY_FILE. It registers authenticated
invocation routes and the signed Director callback when this configuration is
valid. This image alone does not enable the complete browser conversation flow.
Set VERRAIL_CHAT_RUNTIME=opencode and VERRAIL_CHAT_MODEL to an explicit
provider/model on the control plane, then publish and activate the Director
version. The browser requires a secure context (HTTPS or loopback) for request
identity generation. It selects the gateway through the workspace runtime
capability endpoint, not browser-supplied runtime configuration.

Both images run as UID/GID 1000. The domain image uses runtime_env.py, which accepts the registered
PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD file through
VERRAIL_POSTGRES_ENV_FILE and constructs DATABASE_URL without shell evaluation.
VERRAIL_PGX_POOL_MAX adds the pgx-only connection limit; do not set it for the
Node postgres.js client. Allocate Node and Go pools together, not independently.
Mount runtime and migrator credentials only in their respective containers.

The `repository-recovery` service uses the control-plane image and one runtime
database connection. Set `VERRAIL_REPOSITORY_WORKSPACE_IDS` to a JSON array of
authorized existing workspace UUIDs. Empty or malformed scope prevents startup.
It registers persisted repository outputs and confirmed-cleanup cancellation
receipts through the domain API; it cannot
launch a harness, edit a checkout or replace the repository execution scheduler.
Only the runtime PostgreSQL file and domain token are mounted. Loopback port 3213
reports healthy only after a successful scan within the last 15 seconds.
The candidate image must include `server/dist/execution/repository-recovery-main.js`;
the conversation-only baseline image does not satisfy this service contract.

`server/src/execution/repository-execution-main.ts` is the repository controller
entrypoint for Linux. It requires an explicit workspace allowlist, providers file,
OpenCode version and local content-addressed storage root. Without
`VERRAIL_REPOSITORY_REQUEST_FILE`, it polls Go-offered attempts serially, one per
workspace per scan, and waits five seconds between scans. The keyset cursor
advances past invalid inputs so they cannot indefinitely hide later offers.
Setting `VERRAIL_REPOSITORY_REQUEST_FILE` selects one-attempt operation using a
trusted mounted identity packet. It reads the event
cursor from PostgreSQL, validates the live lease and submits each command to the
fixed restricted container gateway. It has no host-shell or in-controller shell
fallback. `VERRAIL_REPOSITORY_CHECKOUT_ROOT` is a private bounded tmpfs shared with
the gateway; `VERRAIL_REPOSITORY_CONTAINER_CONFIG_FILE` names the mounted SSH
configuration. The command container receives only the selected checkout.
The packet contains only Workspace, Target/Graph/Node, Run/Attempt, lease/fence
and AgentVersion/DeploymentRevision identities. Source comes from the Run's
registered provenance revision; model and instructions come from published agent
and pinned Target/Node records. Caller-supplied runtime, prompt and source fields
are rejected. The execution budget is 900 seconds, at most ten output files,
32 MiB per file and 64 MiB in total.
An offered pending attempt is claimed and started through Go events, with
authority rechecked between transitions. Already-claimed or running attempts are
not admitted for another execution. An uncertain claim/start response stops execution rather than
replaying a changed event or launching the harness without confirmed authority.
The controller consumes Go scheduling decisions; it does not activate graph
nodes or allocate attempts. Shutdown stops discovery and awaits active execution
cleanup. It exposes no execution HTTP endpoint. Assembled-image verification is
required before releasing it as the server-side Target execution path.

With the repository runtime profile, ready agent nodes wait for a human-created
Run bound to a selected source provenance revision. The scheduler does not create
unbound repository Runs or infer a latest source. The Run-created outbox event
starts normal attempt allocation. Existing unbound Runs require explicit review;
the scheduler does not silently rebind them.

Cancellation is terminal only after runtime cleanup is confirmed and Go accepts
the fenced `terminated` event. The current controller persists a cleanup receipt
before reporting, so `repository-recovery` can retry an interrupted report without
repeating model or repository execution. Cleanup uncertainty and expired authority
remain unresolved rather than being reported as canceled.

Polling mode exposes `GET /health` on loopback port 3214
(`VERRAIL_REPOSITORY_HEALTH_PORT`). Idle readiness requires a successful scan
within 15 seconds. While preparing or running an attempt, readiness has a
45-second grace window refreshed only after successful controller admission or
Go lease plus dispatch renewal. Long-running work does not require a new scan to
stay healthy. Stale renewal, startup without a successful scan and shutdown are
unhealthy. The response contains no job IDs, credentials or error diagnostics.

`Dockerfile.repository` extends a control-plane image built from the same source
revision and adds pinned OpenCode, Git and the OpenSSH client. Build arg
`CONTROL_IMAGE` must be a verified immutable image; `OPENCODE_VERSION`
is an exact version. The image rejects a control-plane base missing the execution
entrypoint. All repository executors share one private `VERRAIL_REPOSITORY_ROOT`
mount; its exclusive process-tree lock permits one active executor and one database
connection. Together with the other services this allocates 20 connections.
The Compose `repository-executor` service uses this image separately from the
conversation gateway. It shares only the dedicated artifact directory with the
control plane, and has a private execution lock directory. It receives runtime
database, domain API and model provider credentials, not GitHub credentials or
the control-plane secret directory. Source preparation and assembled native
Linux execution acceptance remain release gates.

## Restricted Command Gateway

The seven long-running services use disposable command containers, not a
Landlock-dependent launcher. `Dockerfile.repository-command` builds the separate
secret-free Node/Git/Python tool image from a pinned `NODE_IMAGE`. Freeze its actual
OCI digest in the root-owned gateway policy. The command image does not contain
the controller, provider configuration or database credentials.
The supplied image contains Node, Git and Python. Projects needing additional
toolchains or offline dependencies require a reviewed replacement image; commands
cannot enable networking or install host tooling to fill missing dependencies.

`repository-container-gateway.py` is a fixed-command host operations helper,
invoked over SSH by a dedicated `verrail-command` identity. It accepts only
bounded `start`, `poll`, and `stop` JSON packets. The caller cannot select an image,
mount, network, user, capability, environment or engine option. Its private key
does not grant a shell, forwarding, Docker-group membership or general sudo.
Project containers never mount the Docker socket. The helper uses the host engine
as the explicitly authorized operations boundary, not as a project service.

Every command container has network `none`, a read-only root, UID/GID 1000,
all capabilities dropped, no-new-privileges, default Docker seccomp, 1 CPU,
512 MiB memory, 64 PIDs, bounded logs and a 16 MiB `/tmp`. Only the exact checkout
is mounted at `/work`, anchored through an open directory descriptor and a
root-owned temporary host bind mount during creation. A PID-1 deadline limits commands to 120 seconds and container teardown
kills detached descendants. Command output is bounded to 1 MiB. The gateway
confirms removal before acknowledging cleanup; uncertain engine responses never
establish cancellation. Durable command IDs and stop tombstones prevent replay.

The host checkout root is a dedicated 512 MiB tmpfs at
`/opt/maco-apps/verrail/test/data/repository/workspaces`, owned by UID/GID 1000,
mode 0700, nosuid/nodev. It is executable for build/test artifacts. It must be
mounted before starting the executor. An absent tmpfs fails startup; no disk
fallback or implicit host remount is allowed. The provided first-install script
does not change fstab, so an authorized operator must restore this mount after
a host reboot before starting repository execution.

After owner authorization, a reviewed root-owned source export can run
`install-repository-container-gateway.py --image <verified-command-image-digest>`.
The first-install-only script requires successful live platform inspection,
rejects existing identities/configuration, creates the bounded scratch and fixed
policy, and runs real-container acceptance before enabling SSH authority. It
pins the origin host's Ed25519 key without changing sshd, shared networks or
databases. The protected runtime secret directory receives `container-runner.json`,
`container-runner-key` and `container-runner-known-hosts`; Compose mounts these
individual files only into the trusted executor. Native and installation receipts
live under `/opt/maco-ops/apps/verrail/test/`. An interrupted install requires
inspection, not a blind rerun or overwrite. `--resume-prepared` accepts only the
matching policy and empty scratch after an inspected preparation-only failure;
it still refuses an existing SSH identity or credential files.

Updates require verifying the installed helper and policy against the recorded
hashes, preserving the reviewed version and atomically installing root-owned
replacements. To revoke command authority, remove only this identity's authorized
key and sudoers entry after stopping/draining the executor. Remove only containers
whose exact Verrail command name and ownership label agree. Preserve durable
tombstones while delayed requests remain possible. Do not prune Docker globally.

`repository-container-native.py` exercises the admitted policy against the real
engine: writes/output, no credentials/network/socket/artifact mount, read-only
root, bounded output, timeout, cancellation of detached descendants, repeat-start
idempotency and stop-before-start. It does not prove the SSH transport or the full
Target lifecycle. The `repository-container-client.ts` fixture bundles the
production TypeScript transport into `Dockerfile.repository-container-client-fixture`.
Its separate `container-client.compose.yaml` and `container-client-manifest.json`
describe a one-shot, database-free verification job. Validate the rendered job
through the unmodified maco preflight, then run only `container-client-check`.
It verifies pinned SSH, shared checkout, timeout and abort cleanup from a
non-root Docker client. It does not replace seven-service checks.

The registered `postgres.env` and `postgres-migration.env` stay root-owned 0600
and remain credential sources of truth. Authorized release provisioning must
materialize identical protected mount copies at `runtime/postgres.env` and
`migration/postgres-migration.env` under the same project secret root. Copies are
UID/GID 1000, mode 0600, beneath root-owned 0700 host directories. Docker mounts
only the individual file, not its parent directory. Validate content equality
without displaying values and refresh copies atomically during credential
rotation. This allows non-root containers to read credentials without changing
the registered files or granting world read access. Other mounted secret files
use the same UID/mode and protected-parent pattern. This preparation is a separate
authorized maco operation; no provisioning has been performed by these sources.

BETTER_AUTH_SECRET_FILE, VERRAIL_DOMAIN_API_TOKEN_FILE and
OPENCODE_SERVER_PASSWORD_FILE load single-value secrets. Supplying both a file
and an inline value fails. Do not include credentials in arguments or print
resolved Compose output. Mounted files must be readable by the container UID
without making host secrets world-readable; privileged provisioning remains a
separate release step.

Build from a sanitized frozen source export. The root .dockerignore excludes
local delivery records, environment files and recovery identities, but is not a
complete secret scanner. Base and dependency provenance, linux/amd64 builds,
health checks, bounded resources, persistent mounts, Temporal storage, migrations,
and the maco platform preflight all remain release gates. COS backup is not a
maco deployment gate. Platform inspection records backup verification as not
performed; a passing inspection does not establish current recoverability.

Local launcher and Compose structure tests (not the release preflight):

```sh
python3 -m unittest discover -s docker/maco -p 'test_*.py'
```

Local image packaging checks after building candidate images:

```sh
VERRAIL_TEST_CONTROL_IMAGE=verrail-control-plane:local-check node --test scripts/smoke/control-plane-image.test.mjs
VERRAIL_TEST_DOMAIN_IMAGE=verrail-domain:local-check node --test scripts/smoke/domain-image.test.mjs
VERRAIL_TEST_GATEWAY_IMAGE=verrail-gateway:local-check node --test scripts/smoke/gateway-image.test.mjs
```

These checks use read-only containers without networking. They establish image
identity/runtime prerequisites, not authenticated full-stack readiness.

Local release-Compose startup and login fixture (requires all five locally built
images plus `postgres:17-alpine`; no real provider credentials):

```sh
VERRAIL_TEST_MACO_COMPOSE=1 node --test scripts/smoke/maco-compose.test.mjs
```

This fixture derives its services from the release Compose, replaces only image
references, unique local bind paths, network names and the loopback test port,
and provisions a disposable PostgreSQL on an isolated local database network.
It retains the runtime bridge and all service permissions/resource limits. The
fixture uses random credentials and never contacts a paid model. An additional
fixture-only provider container speaks the model protocol to the real OpenCode
binary. A transactional fixture seeds a workspace, Director version and
conversation; this does not test workspace creation or version publication UI.
It checks all seven service health states, the first-operator job, disabled public
signup, authenticated HTTP access, the six scoped Director tools, persisted SSE
output and idempotent replay after control-plane restart. It also verifies that
SSE disconnect does not cancel execution, explicit cancellation reaches a
terminal acknowledgement, and a SIGKILL/restart of the gateway marks interrupted
work failed instead of reporting success. A control-plane SIGKILL during a live
request preserves invocation identity, does not repeat the provider request, and
allows cancellation after the replacement controller acquires its lease. A
fully consumed SSE cursor receives no duplicate events after restart. It does
not prove a Target Run. The capacity check admits three simultaneous conversations,
rejects a fourth, completes cancellation, and sends 60 concurrent authenticated
API reads while sampling aggregate runtime-role connections 900 times over about
45 seconds. It requires successful requests and a measured peak within the
20-connection allocation. This is a bounded conversation workload, not a Target
workflow load test or a throughput/SLO benchmark.
An explicitly configured public loopback URL uses the host-published port, not
the container's internal listener port.
The control-plane hostname allowlist includes the exact `control-plane` service
name for authenticated Director callbacks; no wildcard hostname is required.

Repository execution requires the admitted restricted gateway and its shared
checkout root. The local conversation fixture does not provision host SSH/sudo
authority and explicitly rejects `VERRAIL_TEST_COMPOSE_REPOSITORY=1`; it cannot
claim repository acceptance. Its repository lifecycle assertions remain fixtures
for a gateway-aware stack runner. Full native-amd64 verification must exercise a
source-bound Run, registered patch bytes/hash, active-command cancellation and
recovery after interrupted registration without repeated model execution. This
remains an acceptance gate, including real GitHub acquisition and provider
integration where required. `VERRAIL_TEST_COMPOSE_REPORT` optionally records the
conversation fixture result. Legacy Landlock smoke tests are opt-in backend tests,
not a kernel requirement of this container deployment. CPU emulation is not a
substitute for native container-boundary checks.

Local Temporal database fixture after building its candidate image:

```sh
VERRAIL_TEST_TEMPORAL_IMAGE=verrail-temporal:local-check VERRAIL_TEST_POSTGRES_IMAGE=postgres:17-alpine node --test scripts/smoke/temporal-postgres.test.mjs
```

Add `VERRAIL_TEST_TEMPORAL_WORKFLOWS=1` to run the three opt-in Go recovery,
worker-restart and live-history replay tests against this same isolated Temporal
server. This option requires local Go, publishes one ephemeral loopback-only
Temporal port, and creates a disposable `default` namespace. The workflows are
real; their activities are fixtures, so this does not prove repository execution
or end-to-end domain database reconciliation. All fixture resources are removed.

Add `VERRAIL_TEST_CONTROL_IMAGE=verrail-control-plane:local-check` to exercise
the packaged application migration job twice before Temporal migrations. This
also checks invocation-table presence and runtime schema CREATE denial.
It exercises the packaged first-operator job, verifies repeat initialization is
a no-op, and rejects bootstrap with the application database role.

The fixture requires a local Unix-socket Docker daemon and cleans only its
uniquely named containers/network. Its PostgreSQL image is a local test resource,
not a service in the maco manifest. Maco uses registered pg-main exclusively.

## First Operator

Public signup remains disabled. After application migrations, an authorized
operator runs the `migrate` job with `bootstrap.compose.yaml` as an explicit
overlay. Validate the exact base-plus-overlay configuration through the release
preflight before running it. The overlay preserves the migration identity,
networking, non-root user and resource limits; it introduces no extra service.
Never use this overlay with `up` or the normal schema migration command.

Supply one JSON object with `name`, `email`, and `password` through standard
input. Passwords must contain 16-128 characters. Keep the input outside the
repository in an operator-owned mode-0600 file under a protected directory;
never place it in arguments, Compose variables, logs, or release artifacts.
The authorized command shape is:

```sh
docker compose -f docker/maco/compose.yaml -f docker/maco/bootstrap.compose.yaml run --rm --no-deps -T migrate < /protected/operator-input.json
```

The job requires private authenticated mode, disabled signup, and the registered
`verrail_test_migrator` role on `verrail_test`. User, password hash and instance
administrator role are created in one transaction. Existing accounts are never
promoted by email; concurrent attempts create at most one first administrator.
Repeated initialization returns `already_initialized` without changing credentials.
Keep only the sanitized status/user-ID receipt and remove the protected input
after verifying login. This job does not enable public registration or replace
an account recovery procedure. Verify first login against the deployed instance;
local fixture evidence does not replace that release check.

## Local Deployment Policy Check

With the five `:local-check` images built locally, validate the base Compose
and first-operator overlay against the unmodified platform checker:

```sh
VERRAIL_MACO_PREFLIGHT_PATH="$HOME/.codex/skills/maco-deploy/scripts/preflight.py" node --test scripts/smoke/maco-preflight.test.mjs
```

This local-only test uses the images' actual OCI index digests, verifies that
mutable tags are rejected, and confirms host-path validation cannot pass off
maco. These local references are not published registry references. Static
validation does not establish host inventory, capacity allocation, backup
receipts, image pullability, or authorization to deploy. The exact published
release still requires all server-side gates.

## Gateway Fixture

Local gateway bundle and real binary fixture verification (no paid model calls):

```sh
node scripts/build-execution-gateway.mjs
VERRAIL_TEST_OPENCODE_HTTP=1 pnpm exec vitest run --project @paperclipai/server server/src/execution/opencode-runtime.test.ts --maxWorkers=1
```
