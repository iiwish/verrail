# Frozen Candidate Verification

Code commit: `141f411f6ea36c3c3a9604d0db4c7cacff2a079e`

Branch: `codex/g2-7-production-closure`

Base: `be6e92b992feec5739f8aa0af172e2aaa3a74f86`

Disposition: local source freeze verified; human review and maco release checks remain separate. No push, PR, deployment or external model execution was performed.

## Results

| Check | Result |
| --- | --- |
| Full workspace typecheck | Passed; final OpenAPI change additionally passed server typecheck |
| Full workspace build | Passed; final OpenAPI change additionally passed server build stamped with the code commit |
| Vitest project coverage | All 19 configured projects covered through full groups and focused failure reruns |
| Server general group | 445 files initially passed; the single failing native-graph fixture was corrected and all 4 tests reran successfully; one conditional file remained skipped |
| Server route group | All 148 planned route files passed across the recorded runs; no missing files |
| UI | 503 files, 4543 tests passed |
| CLI | 57 files initially passed; the remaining import-transfer timeout passed in the focused rerun |
| Shared / skills / database | 618 / 22 / 101 tests passed |
| Adapter utilities | 50 files initially passed; the remaining process-cleanup test passed with its complete 92-test file |
| Other adapters and plugin packages | All 94 files covered; two obsolete transport fixtures corrected and rerun; platform-conditional skips retained |
| Standalone Go integration | 291 tests, 3 packages, zero skips; all 3 required Temporal recovery tests passed with isolated PostgreSQL and Temporal |
| TypeScript-owned Go proof bridge | 79 tests passed with VERRAIL_TEST_CODEX_GO_BRIDGE=1, zero skips |
| CI proof contract | 29 tests passed |
| Stable runner contract | 16 tests passed, including exact configured-project coverage |
| Node version policy / UI tokens / brand assets / bundle budget | Passed |
| Chat proxy / workflow Node version unit tests | 3 / 2 tests passed |
| Migration safety | Build gate passed with 20 existing baseline findings and one stale baseline entry |
| Source whitespace / staging credential-pattern scan | Passed; no live runtime logs or credentials staged |

The first `pnpm test:run` invocation stopped at a regression. Results above are the aggregate of complete groups plus explicit reruns, not a claim that the first invocation was green. Logs retain failures and resource-contention timeouts. Conditional/platform-specific Vitest skips are not counted as passes.

## Fixes

- Corrected public font URLs and lazy-loaded the target workbench; the main bundle is 7.19 MiB raw / 1.98 MiB gzip and passes the unchanged budget.
- Removed the unreferenced multi-deployment UI and replaced obsolete roster assertions with current product workflow coverage.
- Synchronized native graph and remote transport test fixtures with current contracts.
- Bounded database test concurrency and included every configured adapter project in the stable runner.
- Enabled the real TypeScript-owned Go bridge fixture in CI. Only its externally driven helper is excluded from standalone Go invocation; the standalone zero-skip validator is unchanged.
- Documented all mounted conversation context, proposal confirmation and invocation-token MCP endpoints in OpenAPI.

## Exclusions And Release Limits

- Existing `.verrail` runtime state, live logs and earlier delivery records remain on disk outside the source commits. Their presence means the overall working tree is intentionally not empty.
- `pnpm check:tokens`, the inherited npm publication privacy scanner, fails on the local username in legitimate repository URLs and existing delivery records. It was not bypassed. npm publication is not approved.
- Application Docker images, maco inventory, off-host backup gate, ingress/authentication and deployment rollback have not been verified in this target. Local trusted development mode must not be publicly exposed.
- Browser verification covered the existing workbench loading after refresh and showed no captured console errors. Dedicated browser release-smoke/authentication suites and real model/provider runs were not executed.
- Candidate workflow hashes require review against any registered fixed-CI trust profile before a future release. This task did not update live trust policy.

Raw logs are retained locally under `runs/run-001/` and excluded from Git. `evidence.json` records their hashes; they must be archived explicitly before sharing this proof outside the machine.
