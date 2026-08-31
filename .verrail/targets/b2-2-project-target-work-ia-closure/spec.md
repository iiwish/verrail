# B2.2 Project-Target-Work Information Architecture Closure

## Problem

The canonical Verrail ontology defines `Project -> Target -> Work`, but the inherited Project UI still presents Tasks as the primary child and adds Targets as a parallel header action. The resulting navigation implies two competing ownership models.

## Goal

Make Target the visible delivery unit inside Project and contain inherited Issue workflows behind an explicit compatibility boundary without removing existing behavior.

## Context

Native Target creation and read models are available. Native WorkGraph and WorkNode writes are not yet implemented, so existing project-scoped Issues must remain usable until they can be linked or migrated safely.

## Scope

- Define the Project, Target, WorkItem, and legacy Issue relationship canonically.
- Replace Project-list task metrics with permission-filtered Target metrics under Verrail navigation.
- Integrate Targets into the Project detail tab shell and make Overview the Verrail default.
- Keep one Project-level New Target action.
- Relabel inherited Tasks as Legacy Work and explain the compatibility boundary.
- Preserve classic navigation and all existing Issue routes.
- Cover the API summary, navigation resolution, locale parity, and representative browser journeys.

## Non-goals

- No Issue data migration or deletion.
- No automatic Issue-to-Target equivalence.
- No native WorkGraph or WorkNode implementation.
- No change to Go Target command authority.
- No release or merge action.

## Constraints

- Authorization must be applied before Target summaries are calculated.
- New links use canonical Project and Target routes; legacy deep links keep working.
- UI components use the existing token layer only.
- Compatibility copy must not imply that legacy Issues are already linked to a Target.

## Acceptance Criteria

1. The canonical hierarchy is explicit in product and navigation contracts.
2. Project list rows show open Target and attention counts under Verrail navigation.
3. Project Overview and Targets become the leading Verrail tabs and bare Project routes land on Overview.
4. Targets use the Project detail shell, breadcrumbs, and single New Target command.
5. Existing Issues remain operable as Legacy Work and old `/issues` routes remain valid.
6. Classic navigation remains Tasks-first.
7. Focused tests, locale validation, token gates, typecheck, build, browser checks, and diff checks pass or are recorded as gaps.

## Risks

- Cached classic tabs could override the Verrail default unless the two navigation modes are resolved separately.
- Target metrics could leak unauthorized data unless computed after access filtering.
- Calling all project Issues “unassigned” would invent a relationship that the current model cannot prove; the UI therefore uses “Legacy Work.”

## Open Questions

None for this slice. Native Work ownership and Issue migration are deferred to the WorkGraph phase.
