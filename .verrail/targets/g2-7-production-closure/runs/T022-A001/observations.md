# T022 Reproduction

Observed at 2026-09-05T02:02:41Z on the G2 closure instance, port 3270.

- The port owner is Node PID 76904 with cwd `/Users/iiwish/self/verrail/server`.
- Initial navigation and explicit reload both show the application error boundary:
  `Cannot read properties of null (reading 'useRef')`.
- Browser error stack points to Radix TooltipProvider and React's invalid hook call.
- The live server serves React DOM with a dependency on
  `chunk-DF4QBPBD.js?v=b55a380c`, but the Radix chunk imports
  `chunk-DF4QBPBD.js` without that version.
- The shared `ui/node_modules/.vite/deps/_metadata.json` currently records
  browser hash `3f3d7ca0`, different from the running server's `b55a380c`.
- The server creates embedded Vite instances without an explicit cache directory;
  development and acceptance servers in this checkout share the optimizer files.

This is a development-runtime cache ownership defect, not evidence that the
production bundle is broken. The native Target still requires separate execution
and provider acceptance after the workbench is restored.
