# B2.2 Acceptance Mapping

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Canonical `Project -> Target -> Work` hierarchy | `docs/product-design.md`, `docs/navigation-contract.md` | Passed |
| Authorized Target metrics replace task counts in Verrail Project rows | `TargetListResponseV1.summary`, `summarizeTargets`, route and Project page tests | Passed |
| Bare Verrail Project routes open Overview and tabs prioritize Targets | `ProjectDetail.tsx`, App route tests, browser route verification | Passed |
| Targets render in the Project shell with one New Target action | Project Targets browser check and dialog preselection check | Passed |
| Inherited Issues remain operable under an honest compatibility boundary | Legacy Work route, copy, preserved task controls, old Issue routes | Passed |
| Classic Tasks-first behavior remains | Mode-separated route and tab resolution plus unchanged classic tab labels and paths | Passed |
| English and Simplified Chinese parity and token compliance | Locale validation and `pnpm check:token-gates` | Passed |
| Verification is recorded truthfully | Focused 32-test pass, typechecks, builds, browser matrix, diff check, and inherited full-suite baseline | Passed with inherited baseline noted |

This run does not approve a commit, merge, deployment, release, or ship decision.
