# B2.3 Frontend Acceptance Closure

## Problem

The B2 frontend flows are functionally coherent, but the branch is not yet an acceptance candidate. Storybook has incompatible package versions, the principal Verrail journey lacks an isolated deterministic browser gate, three tests become unreliable under concurrent load, shared close controls expose an English-only accessible name, and bundle growth is visible but unenforced.

## Goal

Create a repeatable frontend acceptance path that proves the B2 product flow and makes remaining risk explicit before a merge decision.

## Scope

- Align Storybook core, renderer, and addon versions and restore the static build.
- Localize shared Dialog and Sheet close labels without changing visual behavior.
- Stabilize the observed CompanyEnvironments, IssuesList, and cron-fires tests while preserving their assertions.
- Add an isolated Playwright acceptance journey for Project, Target, Target workbench, and Legacy Work navigation.
- Exercise the journey at desktop and narrow-desktop viewports and fail on browser errors.
- Add an explicit frontend production-bundle baseline budget.
- Run and record the complete B2 frontend verification set.

## Non-goals

- No WorkGraph, Stage, Temporal, or Go backend expansion.
- No Issue migration or compatibility-route removal.
- No new information architecture or visual redesign.
- No broad bundle splitting or performance program in this slice.
- No commit, merge, deploy, release, or self-approval.

## Constraints

- Browser acceptance must boot from an isolated disposable data directory and must not depend on the developer's current database.
- Test stabilization must retain the behavioral assertions; it may use condition-based waits or an explicit performance-test timeout instead of fixed sleeps.
- Accessible names must come from the existing locale contract.
- UI edits must use the existing token layer and pass token gates.
- Bundle thresholds must be derived from and remain close to the measured B2 baseline, not act as an unlimited placeholder.

## Acceptance Criteria

1. `pnpm build-storybook` succeeds with one exact Storybook version family.
2. The Verrail Playwright acceptance suite passes at 1440x900 and 1024x768 from a clean isolated instance.
3. The acceptance journey covers Projects, Project Overview, Targets, Target workbench, and Legacy Work, and reports no uncaught page or console errors.
4. Dialog and Sheet close controls use the active locale and still dismiss through the keyboard.
5. The three previously unstable tests pass in a grouped stress run and the normal stable UI suite.
6. A production-bundle budget check succeeds against the recorded B2 baseline.
7. Typecheck, production build, UI tests, locale parity, token gates, brand gates, Storybook, Playwright, and diff checks pass.
8. The receipt, evidence, mapping, screenshots, and advisory review truthfully support a merge-readiness conclusion.

## Risks

- An end-to-end test can appear deterministic while reusing existing local state; isolation and seeded identifiers are therefore mandatory.
- Raising global timeouts could conceal regressions; stabilization is limited to condition waits and the known high-volume assertion.
- A bundle threshold can normalize excessive size; this slice records a close baseline and leaves route-level splitting as a separately visible follow-up.

## Open Questions

None for execution. Final merge approval remains with the user after reviewing the evidence.
