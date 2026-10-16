# T002 Validation Log

Run: `T002-A001`
Completed at: 2026-09-04T05:33:14Z

## Focused Baseline

- `heartbeat-stale-queue-invalidation.test.ts`: four consecutive runs passed, 24/24 tests each. No heartbeat product source change was justified or made.
- Runner cleanup regression RED: 13/14 passed; one failure proved `/private/tmp/pcvt-*` survived a successful invocation.
- Runner cleanup regression GREEN: 14/14 passed after deletion of the per-invocation root in `finally`.
- OpenCode remote-session RED: the unchanged five-second test timed out twice because it copied the operator's 554 MiB `XDG_CONFIG_HOME`.
- OpenCode remote-session GREEN: 1/1 passed in 12 ms after using an empty per-test XDG directory; the timeout and product assertions were unchanged. Full OpenCode project: 7/7 files, 42/42 tests passed.

## Full Vitest Disposition

The first `pnpm test:run` failed after 251 leaked `pcvt-*` roots consumed 11.8 GiB and embedded PostgreSQL returned disk `ENOSPC`. It reported 2 failed tests, 3,466 passed, 234 skipped, and 112 cascading setup-suite failures after the database stopped.

The second `pnpm test:run` proved the temp-root fix across the largest lanes:

- General server: 409 passed files, 4,708 passed tests, 19 skipped.
- UI: 489 passed files, 4,440 passed tests.
- CLI: 58 passed files, 415 passed tests.
- Shared: 69 passed files, 595 passed tests.
- Skills catalog: 5 passed files, 22 passed tests.
- The run then stopped at DB bootstrap because macOS had 28 detached PostgreSQL SysV shared-memory segments and 303 matching semaphore sets against `kern.sysv.shmmni=32`.

After removing only detached, user-owned PostgreSQL IPC state, the DB project passed 26/26 files and 99/99 tests. The remaining workspace projects were executed by the same stable-runner boundaries; the one reproducible OpenCode fixture leak was fixed and all projects passed. The serialized lane then passed all 146 selected suites with no failure.

The stable runner left 0 `pcvt-*` roots, 0 detached PostgreSQL shared-memory segments, and 0 matching semaphore sets after validation.

## Other Checks

- `pnpm -r typecheck`: passed for all 34 selected workspace projects.
- All target JSON and timeline JSONL records: parsed successfully.
- `git diff --check`: passed.

The executable isolation result covers the full Vitest inventory despite the monolithic retry ending at a host IPC ceiling. No test timeout or assertion was relaxed.
