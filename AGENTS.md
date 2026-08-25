# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Verrail is an evidence-driven control plane for governed AI delivery.
The product target is defined in `docs/`; inherited Paperclip documents describe
the current TypeScript implementation only and do not define product direction.

## 2. Read This First

Before making changes, read in this order:

1. `docs/README.md`
2. `docs/product-goals.md`
3. `docs/constitution.md`
4. `docs/product-design.md`
5. `docs/operational-ontology.md`
6. `docs/architecture.md`
7. `doc/DEVELOPING.md`
8. `doc/DATABASE.md`

`doc/SPEC-implementation.md` is an inherited implementation reference while the
domain migration is in progress. When it conflicts with `docs/`, new product work
follows `docs/` and preserves existing behavior through an explicit compatibility
or migration plan.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `packages/skills-catalog/`: app-shipped skills catalog (`@paperclipai/skills-catalog`)
- `packages/teams-catalog/`: app-shipped teams catalog (`@paperclipai/teams-catalog`)
- `cli/`: `paperclipai` CLI package (published bin, agent-facing commands)
- `skills/`: Paperclip runtime/operational skills (not part of the app catalog)
- `docs/`: Verrail product, ontology, architecture, ADRs, and public technical references
- `doc/`: inherited implementation and operational references

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes workspace-scoped.
Every Verrail domain entity belongs to a Workspace and workspace boundaries must
be enforced in routes and services. Existing `companyId` fields are compatibility
storage during migration, not a reason to expand the company/org-chart model.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Versioned AgentDefinition, AgentVersion, and Deployment identity
- Graph Engine authority over node activation and state transitions
- Separate invocation, execution, decision, action approval, and acceptance authority
- Version-bound Artifact, Evidence, Review, and Acceptance
- Lease, fencing, idempotency, budget enforcement, and audit logging

4. Keep the Verrail SSOT aligned.
Product scope changes update `docs/product-goals.md` or `docs/product-design.md`;
semantic changes update `docs/operational-ontology.md`; implementation-boundary
changes update `docs/architecture.md` and an ADR when the decision is durable.

5. Keep temporary plans out of the product SSOT.
Durable product direction belongs in the canonical documents above. Durable
technical decisions belong in `docs/adrs/`. Task checklists, generated reports,
PR screenshots, and transient implementation plans do not belong in `docs/`.

6. Attach inspectable generated artifacts.
The inherited artifact helper and API remain usable while the Verrail Artifact
contract is implemented. Generated deliverables must have a stable workspace or
uploaded reference, content hash, source task/run, and reviewer-visible location.
See `doc/AGENT-ARTIFACTS.md` for the current implementation path.

7. Name the three data paths correctly.
This repo has three separate data paths. Do not confuse them. Match a change to a path by its file path, not by the word "observability" or "telemetry" alone.

- **Telemetry** is the Paperclip first-party event system. It is opt-out and it sends data to a Paperclip endpoint by default. Its paths are:
  - `packages/shared/src/telemetry/`
  - the generated contract `packages/shared/src/telemetry/generated/paperclip-telemetry.ts`
  - each caller of `packages/shared/src/telemetry/events.ts` or `packages/shared/src/telemetry/client.ts`
- **Observability** is the OpenTelemetry trace path. An operator must set an OTLP endpoint. Until an operator sets the endpoint, the tracer is a no-operation. Its paths are:
  - `server/src/instrumentation.ts`
  - `doc/observability.md`
  - `packages/adapter-utils/src/duplex-observability.ts`
  - `server/src/services/duplex-observability-recorder.ts`
  - the span attributes in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`
- **The run log** holds rows in the local `heartbeat_run_events` table. The data stays in the instance database. Its paths are:
  - `doc/run-log-events.md`
  - `packages/db/src/schema/heartbeat_run_events.ts`
  - the append path `appendRunEvent` in `server/src/services/heartbeat.ts`

Apply a review level that matches the path:

- **Telemetry change (strict review).** The author updates the generated contract first. The author updates `packages/shared/src/telemetry/README.md` in the same pull request. The author requests a privacy review. Reason: a Telemetry event goes to a Paperclip endpoint by default, so a mistake sends data immediately.
- **Observability change (lighter review).** The operator endpoint gate stays in place. The no-operation behaviour stays when no endpoint is set. A privacy review is not necessary while the change stays inside the closed span-attribute allowlist.
- **Run-log change (no extra review).** A run-log change needs neither review level above, because the data stays in the instance database.

**Exclusion.** The word "observability" in a file such as `server/src/services/recovery-observability.ts` names a different concept. Apply this rule by path, not by word match.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. New behavior matches the Verrail contracts in `docs/` and explicitly preserves or migrates inherited behavior
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.
