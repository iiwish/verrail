# Brand And Navigation Foundation Spec

## Problem

The Verrail product direction is confirmed, but implementation still lacks a usable brand asset baseline, a reversible workspace navigation switch, protected route roots, and a precise read-model contract for the first Target experience.

## Goal

Create the smallest foundation that lets the next phase implement the Verrail shell and Target experience without unsafe global renames or premature domain writes.

## Context

- `docs/brand-migration.md` and `docs/navigation-contract.md` are confirmed contracts.
- `companies` remains the Workspace compatibility record during migration.
- Existing Paperclip identifiers remain compatibility surfaces until explicitly migrated.
- The current TypeScript application remains the control plane while Go and Temporal are introduced later by vertical slice.

## Scope

1. Produce the B0 brand system and a basic public conflict screen.
2. Inventory visible and technical Paperclip brand surfaces.
3. Add the disabled-by-default `enableVerrailNavigation` Workspace flag end to end.
4. Register the new route roots and reserve them from plugin manifests.
5. Refuse flag activation when an installed plugin already owns a new root.
6. Publish the `TargetReadModel` implementation contract.

## Non-goals

- No app-wide visual or copy rebrand.
- No new authoritative Target mutation path.
- No compatibility identifier, telemetry, package, CLI, database, or environment rename.
- No production Go or Temporal runtime.

## Constraints

- Preserve workspace isolation and board-versus-agent permissions.
- Keep the navigation flag Workspace-scoped and false by default.
- Add behavior through tests before implementation where practical.
- Keep brand assets monochrome-capable, legible at favicon scale, and free of gradients or embedded raster data.
- Treat the name screen as a dated preliminary screen, not legal advice or trademark clearance.

## Acceptance Criteria

The acceptance criteria in `target.json` are authoritative for this delivery target.

## Risks

- New route roots can collide with installed plugins that predate the reservation.
- A workspace flag stored in compatibility data can be mistaken for a permanent domain ownership decision.
- Premature visible rebranding can leak into security, telemetry, cache, or package compatibility surfaces.
- A basic public search can miss unregistered, regional, or confusingly similar marks.

## Open Questions

None block this slice. Legal clearance, public-domain acquisition, and authoritative Target writes remain later gates.
