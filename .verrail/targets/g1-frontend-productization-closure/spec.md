# G1 Frontend Productization Closure

## Problem

The current Verrail shell proves route reachability but does not yet feel like a finished operational product. Infrastructure and Governance render sparse link indexes, then send users into Settings or unscoped legacy pages. The section context disappears, page ownership becomes ambiguous, and the primary shell feels like a prototype instead of the compact Paperclip workbench it inherits.

## Goal

Make every visible top-level management section behave as a persistent workspace. Infrastructure and Governance must use the same contextual-sidebar interaction model as Settings, expose only real capabilities, and keep users inside a coherent section while they browse and act.

## Context

Paperclip already provides the correct shell primitive: a collapsed primary rail, a 240px contextual sidebar, and a full-height operational content area. Verrail should reuse that interaction pattern while applying the canonical product ownership defined in `docs/navigation-contract.md`.

## Scope

- Replace the Infrastructure and Governance index pages with contextual secondary navigation.
- Add canonical section routes backed by existing functional pages.
- Keep important child and detail actions inside the section route where practical.
- Preserve old deep links and classic navigation.
- Correct labels, breadcrumbs, route defaults, Command Palette targets, and responsive behavior.
- Extend deterministic browser acceptance across primary and secondary navigation.

## Non-goals

- No fake management pages for capabilities that do not exist.
- No new Verrail domain or backend authority.
- No full rewrite of inherited feature pages.
- No pull request or ship action in this target.

## Constraints

- Follow `DESIGN.md` and the UI token gate.
- Reuse `SecondarySidebar`, `SidebarNavItem`, current pages, APIs, permissions, and feature gates.
- Verrail links use canonical routes; compatibility routes remain available.
- Page functionality and data authority must not change merely to support navigation.

## Acceptance Criteria

Acceptance is defined by `target.json`. Browser evidence must include Infrastructure, Governance, Settings, desktop, narrow desktop, and representative action paths. Automated coverage must fail on browser errors, stuck skeletons, route loss, or missing active navigation state.

## Risks

- Reusing Settings-owned pages can leak old breadcrumbs or hard-coded back links.
- Route aliases can break refresh or Workspace prefix resolution if registered incompletely.
- A contextual sidebar can crowd narrow desktop widths if the primary rail is not force-collapsed.
- Over-classifying old Settings paths could unexpectedly move Settings capabilities into Infrastructure.

## Open Questions

None for this slice. Only implemented capabilities are exposed; future native Runners, Runtime Pools, Policies, and Storage pages will replace compatibility-backed entries in later goals.
