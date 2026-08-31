# Brand Shell And Primary Navigation Spec

## Problem

The B0 foundation supplies approved brand assets, reserved routes, and a reversible Workspace flag, but the running product still presents the inherited identity and information architecture. The next slice must make the confirmed Verrail direction tangible without creating a second domain model or breaking Paperclip compatibility surfaces.

## Goal

Deliver a browser-verifiable Verrail application shell behind `enableVerrailNavigation` and use existing read APIs to establish the first operational Home experience.

## Product Contract

- The primary navigation is Home, Projects, Agents, Infrastructure, Governance, and Settings.
- Home is an operational inbox and orientation surface, not an analytics dashboard or marketing page.
- Infrastructure and Governance aggregate existing capabilities; they do not create parallel authorities.
- Brand presentation uses the approved B0 Evidence Rail assets and the canonical public domain `verrail.ai`.
- The flag is Workspace-scoped, disabled by default, and reversible without data migration.

## Compatibility Contract

- Existing workspaces retain the inherited shell unless the flag is explicitly enabled.
- Existing task, issue, company, agent, CLI, package, telemetry, environment, storage, and API identifiers remain intact.
- Existing routes remain available. Canonical Verrail routes are additive and registered before plugin wildcard resolution.
- Persisted browser keys and server-side runtime branding injection sentinels remain stable.
- B1 reads current sources but does not claim an authoritative Target write model or Target projection.

## UX Contract

- Use a dense, quiet, desktop-first operational layout with a coherent narrow-viewport fallback.
- Avoid decorative dashboards, nested cards, oversized headings, feature explanation copy, and inactive controls that imply unsupported capabilities.
- Every asynchronous surface has explicit loading, error, empty, and populated states.
- Primary navigation remains stable in order and vocabulary across the sidebar, mobile navigation, and command palette.

## Acceptance Criteria

The acceptance criteria in `target.json` are authoritative for this target.

## Risks

- Visible branding can accidentally rename compatibility identifiers needed by installed clients or runtime injection.
- A navigation-only Target command could imply unsupported write authority.
- Existing read APIs may not fully represent the confirmed Target concept; the UI must name that limitation honestly through its states rather than fabricate data.
- Narrow layouts can hide one of six primary destinations; all destinations must remain reachable even when the persistent mobile bar shows a compact subset.

## Open Questions

None block B1. The authoritative Target projection and New Target workflow belong to the next domain slice.
