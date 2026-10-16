# T013 TDD log

## RED

The model-unavailable diagnostic exceeded its 10-second timeout both in `pnpm test:run` and in an isolated run. The host OpenCode configuration was 554 MB with 7,016 files, and the fixture inherited and copied it before invoking the fake command.

## GREEN

Set `XDG_CONFIG_HOME` in each diagnostic fixture to its own temporary path. The test still executes the fake command, retains production runtime behavior and no longer consumes host configuration.

## Verification

- Focused failing case: 5/5 consecutive runs passed.
- Complete file: 3/3 passed.
- Server typecheck and `git diff --check`: passed.
