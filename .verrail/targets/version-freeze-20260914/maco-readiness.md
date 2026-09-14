# Maco Release Boundary

This target freezes source and verifies local builds. It does not authorize deployment or claim server readiness.

Before deployment:

- Inspect the live maco inventory and require a successful platform and off-host backup gate.
- Run application services and migration jobs in Docker using immutable image digests.
- Use the registered pg-main instance with dedicated database, runtime and migration credentials; do not deploy the local bundled PostgreSQL.
- Review authenticated access before exposing the application. The current local_trusted development instance is not a public deployment configuration.
- Verify migration compatibility, persistent uploads and secret-key backup, health checks, resource limits and rollback image.
- Run deployment-specific smoke tests on the exact frozen commit and image. Local Vitest and builds do not prove ingress, authentication or disaster recovery.

The npm publication token scanner treats the operator username as forbidden, including legitimate repository URLs and existing delivery records. Its failures remain reported separately; this target neither changes that privacy policy nor authorizes npm publication.
