# B2.3 Acceptance Mapping

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Exact Storybook version family and successful static build | Storybook core, renderer, docs, a11y, and Vitest packages at `10.5.8`; `pnpm build-storybook` | Passed |
| Isolated acceptance at 1440x900 and 1024x768 | `playwright.config.ts`, `run-verrail-acceptance.mjs`, two passing Playwright projects, disposable self-cleaning `PAPERCLIP_HOME`, and frozen evidence hashes unchanged by a normal rerun | Passed |
| Project, Target, workbench, and Legacy Work journey without browser errors | `project-target-work.spec.ts`, active-tab and loading-state waits, Playwright report, four screenshots, zero captured page or console errors | Passed |
| Localized Dialog and Sheet close controls with keyboard dismissal | `dialog.tsx`, `sheet.tsx`, `dialog-sheet-i18n.test.tsx`, New Target Escape step | Passed |
| Observed UI flakes remain behaviorally asserted and stable | Grouped stress checks, final 96-test focused set, and 481-file/4406-test UI suite | Passed |
| Production bundle baseline is explicit and enforced | `check-ui-bundle-budget.mjs`, its Node tests, measured 11.50 MiB raw / 3.31 MiB gzip aggregate, and required PR/release workflow steps | Passed |
| Frontend acceptance verification gates are green | Workspace typecheck/build plus final UI typecheck/build, UI tests, locale parity, token gates, brand gates, Storybook, Playwright, bundle tests, and diff check | Passed |
| Delivery record supports an inspectable merge-readiness decision | Receipt, evidence JSON, acceptance mapping, Playwright report, hashed screenshots, and advisory review | Passed; independent review remains required |

The repository-wide `pnpm test:run` retains 27 unrelated environment-sensitive failures in server/runtime groups. This is recorded as residual repository risk rather than represented as a frontend pass. This run does not approve a commit, merge, deployment, release, or ship decision.
