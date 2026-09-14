# Maco Container Build Components

These are candidate build and Compose components, not an approved release.
`compose.yaml` and `deploy/maco.json` declare five services and three one-shot
jobs. Image variables require operator-supplied verified digests; no release
digest set is frozen. Durable invocation routes require explicit gateway
configuration. An authenticated application/OpenCode fixture verifies scoped
tools, persisted replies and cancellation against a local provider simulator.
Full-stack and real-provider acceptance remain incomplete.

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
runtime pool allocation is Node 6, Domain API 2, worker 2 and Temporal at most 8;
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
backup and the maco platform preflight all remain release gates.

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

Local release-Compose startup and login fixture (requires all four locally built
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
It checks all five service health states, the first-operator job, disabled public
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

With the four `:local-check` images built locally, validate the base Compose
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
