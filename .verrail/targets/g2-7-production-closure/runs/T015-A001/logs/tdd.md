# T015 Verification

- RED: a real Workbench command using the compatibility Agent UUID failed with `DEPLOYMENT_REVISION_NOT_ACTIVE`.
- GREEN: the UI loads active DeploymentRevision facts and sends the selected revision to both Graph and Run commands.
- The focused suite passed 18/18, UI typecheck passed, token gates were clean, and `git diff --check` passed.
- In the real browser, `Director / Workspace default r2` resolved to `0c72a87d-9956-4cae-97c7-98f6f4ae8e47`; the UI created and activated GraphRevision `af4108ab-8821-4228-9786-5b51117a47a7`.
