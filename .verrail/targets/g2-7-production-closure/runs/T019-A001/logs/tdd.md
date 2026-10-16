# T019 TDD Log

## RED

The focused Codex ACP suite failed because the local effective config preserved
`CODEX_HOME` but did not contain `CODEX_PATH`. The first real evaluation had already
shown the consequence: three heartbeat runs ended with `acpx_session_init_failed`
while the package-local Codex shim reported a missing Darwin ARM64 optional package.

## GREEN

`buildCodexAcpConfig` now receives the execution context. For local targets it binds
`CODEX_PATH` to the runtime command selected by the compatibility adapter. It keeps a
non-empty explicit override and leaves remote target resolution on the target side.

The focused suite passed 29 tests and adapter typecheck passed. Real heartbeat run
`7ee30b95-3216-425a-b7c5-ca902c569a2b` then opened an ACP session with
`gpt-5.6-sol`, completed MYW-1, and recorded 2,041 input, 38,656 cached input, and
114 output tokens.

## Residual Boundary

The real retry used the board wakeup command because the Mac was locked. It proves
the product runtime fix, but it does not replace the final browser-only journey
required by T010.
