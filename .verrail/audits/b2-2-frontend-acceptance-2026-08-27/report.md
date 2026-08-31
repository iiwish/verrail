# B2.2 Frontend Acceptance Audit

Date: 2026-08-27

Scope: Verrail navigation, Project -> Target -> Work information architecture, Target Workbench shell, legacy route compatibility, desktop and narrow-desktop behavior, and frontend acceptance infrastructure.

## Decision

`B2.2` is functionally coherent and the inspected Project/Target/Legacy Work journeys are usable, but the branch is not yet merge-accepted as a frontend release candidate.

The remaining merge gates are acceptance-infrastructure gaps rather than a detected B2.2 data-loss or navigation regression:

1. Storybook cannot build because `storybook` is pinned to `10.5.5` while the installed Storybook addons require `10.5.8`.
2. The full UI suite is not deterministic under parallel load. One run passed all 4,401 tests before the added audit coverage; the latest 4,404-test run produced three unrelated failures that passed on narrower reruns.
3. The B2.2 journey is not protected by a dedicated Playwright specification with deterministic seed data.

## Fixes Applied During Audit

- Added the missing `DialogContext` test double required by the Project-level New Target action.
- Added focused Project detail coverage for the Verrail Targets surface, Legacy Work boundary, single New Target action, and bare-route Overview default.
- Added the Project link to Target Workbench breadcrumbs so the visible hierarchy is Workspace -> Project -> Target on every Target tab.

## Functional Journey Results

| Journey | Result | Notes |
| --- | --- | --- |
| `/MIN/projects` | Pass | Project remains visible and reports authorized Target metrics instead of task counts. |
| Bare Project route | Pass | Redirects to Project Overview in Verrail mode. |
| Project Overview | Pass | Shows recent Targets and one Project-level New Target command. |
| Project Targets | Pass | Uses the Project shell, section breadcrumb, canonical list, and one New Target command. |
| New Target dialog | Pass | Project is preselected; required-field gating, cancel, and long-form scrolling are operable. Mutation semantics are covered by component tests. |
| Project Legacy Work | Pass | Existing task search, views, filters, creation, and empty state remain available with explicit compatibility copy. |
| Target Overview | Pass | Responsibility contract, stage, risk, acceptance criteria, and delivery proof summary render from the read model. |
| Target tabs | Partial by product scope | All routes and selected-tab states work; Stages, Work, Submission, Artifacts, Evidence, Runs, and Timeline currently render honest empty projections. |
| `/MIN/agents/paused` | Pass | Existing nested Agent route remains reachable through the new shell. |
| Console | Pass | No error or warning entries were observed during the inspected journeys; only Vite and React development messages appeared. |
| 1440x900 and 1024x768 | Pass | No incoherent overlap, clipped navigation, or inaccessible dialog footer was found. |

## Automated Verification

| Gate | Result |
| --- | --- |
| B2.2 ProjectDetail and TargetWorkbench tests | 2 files, 13 tests passed |
| Full UI suite, first audit run | 480 files, 4,401 tests passed |
| Full UI suite after added coverage | 477 files passed, 3 files failed; 4,401 tests passed and 3 failed out of 4,404 |
| Failure reruns | `CompanyEnvironments` and `cron-fires` passed together; the exact `IssuesList` timeout case passed alone |
| UI typecheck | Passed |
| UI production build | Passed with inherited CSS/font/import and large-chunk warnings |
| Token gates | 801 files scanned; all four gates clean |
| Brand assets | 17 assets validated |
| Diff whitespace | Passed |
| Storybook build | Failed before story compilation because Storybook core/addon versions are mismatched |

## Product Gaps

These are not hidden regressions. They are the remaining G1/G2 product implementation:

- Native Target revision editing and publication.
- WorkGraph, GraphRevision, WorkNode creation, assignment, dependency, and gate interactions.
- Authoritative Stage progression rather than an empty projection.
- Target-scoped Run details and Temporal-backed execution controls.
- ArtifactRevision, Evidence, VerificationResult, immutable Submission, DeliveryReview, and Acceptance.
- Target Timeline events and actionable Attention states.

The UI should not simulate these capabilities before the Go domain contracts exist.

## UX And Accessibility Follow-ups

- The shared Dialog close control exposes the English screen-reader label `Close` in the Chinese locale.
- Target empty tabs are truthful but passive; once the corresponding domain slice exists, each should expose the next legitimate action rather than remain a single-line empty state.
- Sparse Project and Target lists are clear but visually underuse wide screens. This is polish, not a merge blocker.
- The production bundle is approximately 7.37 MB before compression and 2.04 MB gzip for the main chunk; establish a route-level performance budget before broader rollout.

## Proposed Next Target

`B2.3 Frontend Acceptance Closure`

1. Align all Storybook packages on one exact version and restore `build-storybook` plus accessibility stories for the changed surfaces.
2. Add one deterministic Playwright journey covering Projects -> Overview -> Targets -> New Target dialog -> Target Workbench -> Legacy Work at 1440x900 and 1024x768.
3. Stabilize or isolate the three concurrency-sensitive UI tests so the same full-suite command is repeatably green.
4. Localize shared dialog and sheet close labels and run keyboard/focus checks for the New Target flow.
5. Add a route-level bundle report and record a baseline budget; optimization can follow unless the agreed threshold is exceeded.
6. Rerun typecheck, full UI tests, build, Storybook, token gates, browser journeys, and diff checks; attach screenshots and obtain independent product/engineering review.

After B2.3, the next product slice should be a minimal Target-owned WorkGraph and Stage vertical slice backed by Go and Temporal. It should make `Work` and `Stages` real before expanding the remaining Workbench tabs.

## Accepted Visual Evidence

- `screenshots/02-projects-desktop.png`
- `screenshots/03-project-overview-desktop.png`
- `screenshots/04-project-targets-desktop.png`
- `screenshots/05-new-target-dialog.png`
- `screenshots/09-legacy-work-narrow-stable.png`
- `screenshots/11-target-narrow-retry.png`
- `screenshots/12-new-target-dialog-narrow-bottom.png`
- `screenshots/13-agents-paused-desktop.png`
- `screenshots/14-target-breadcrumb-fixed.png`

The transient loading captures are retained as diagnostic evidence but are not visual acceptance references.
