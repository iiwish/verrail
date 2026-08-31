# Verrail Brand Surface Inventory

Inventory date: 2026-08-26 UTC

## Snapshot

The case-insensitive repository scan found 2,940 files containing `paperclip`; 780 are under the UI application surface, 1,021 are under package/CLI surfaces, and 10 are in the first-party telemetry contract path. Counts include tests, fixtures, generated contracts, and inherited documents, so they are an upper bound rather than a rename checklist.

## B1: Migrate Product Shell

These surfaces may adopt the Verrail visual identity behind the Workspace-scoped navigation flag:

| Surface | Representative paths | B1 treatment |
| --- | --- | --- |
| HTML and browser identity | `ui/index.html`, `ui/public/site.webmanifest` | Switch title, theme presentation, favicon, and installed-app presentation only under the approved release plan. Preserve cache/version compatibility separately. |
| Shell logo and product name | `ui/src/components/AnimatedPaperclipIcon.tsx`, sidebar/company menu components | Introduce Verrail assets through one brand component; do not fan out raw SVG imports. |
| Entry and recovery screens | `ui/src/pages/Auth.tsx`, `ui/src/pages/InviteLanding.tsx`, onboarding/bootstrap pages, not-found and system-notice surfaces | Change user-visible product identity while preserving protocol, auth, and route identifiers. |
| New navigation | sidebar, command palette, breadcrumbs, mobile navigation, route titles | Render the confirmed Verrail information architecture only when `enableVerrailNavigation` is true. |
| PWA assets | manifest icons, Apple touch icon, favicon variants | Use the verified assets in `ui/public/brand/verrail/`; explicitly version service-worker caches. |

## B2: Audit And Batch Visible Copy

User-visible strings in pages, components, locale resources, empty states, dialogs, errors, help content, and tooltips should be classified by workflow and updated in batches. A string match is not sufficient: email source content, logs, model output, example data, and imported package content must remain untouched unless a separate contract says otherwise.

High-value candidate workflows include authentication and invitations, workspace settings and portability, agent creation and runtime status, projects/cases/issues, approvals/governance, tools/apps/plugins, and help/about surfaces.

## Preserve As Compatibility Identity

These paths must not be changed by brand sweeps:

| Class | Representative paths | Reason |
| --- | --- | --- |
| Package and module names | root/package manifests, `@paperclipai/*` imports, lockfile entries | Published and internal dependency identity. |
| CLI and environment contracts | `cli/`, `PAPERCLIP_*`, config/data directories, process names | Installation, scripts, automation, and operator compatibility. |
| Authentication and security keys | board auth, API-key prefixes, token claims, cookie/header/storage keys | Renames can invalidate credentials or weaken compatibility. |
| API and database identifiers | `/api`, company fields, table/column names, migration history | They are technical migration surfaces, not visible brand copy. |
| Telemetry | `packages/shared/src/telemetry/` and generated `paperclip-telemetry.ts` | This is a separately governed, privacy-reviewed outbound contract. |
| Plugin compatibility | package keys, plugin IDs, slots, SDK namespaces, persisted manifests | Existing plugins and installed records depend on stable identity. |
| Runtime and cache keys | `ui/public/sw.js`, local storage, service workers, worktree/runtime directories | Silent renames can strand state or create two active caches. |
| Historical and attribution records | changelogs, inherited specs, licenses, font notices, commit/PR references | Historical truth and third-party attribution must remain intact. |

## B3: Defer Public And Distribution Surfaces

The root README, public documentation, CLI package publication, container images, install scripts, release channels, marketplace metadata, and external links move only after B1 is stable and ownership/clearance gates are met. Where both names must coexist, use an explicit compatibility sentence rather than replacing identifiers inside commands.

## Execution Rule

Every brand batch starts from a classified file list, changes user-visible identity only, runs representative workflow tests plus parity/type checks, and reports residual technical identifiers. Global search-and-replace is prohibited.
