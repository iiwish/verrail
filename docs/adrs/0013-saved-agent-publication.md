# ADR 0013: Saved Agent Configuration Publication

Status: Publication decision accepted; runtime consumption superseded by [ADR 0014](0014-single-effective-agent-version.md).

## Decision

Agent detail owns publication and version/deployment operations. Publication accepts a preview hash, not a second editable configuration form. The BFF reads saved instruction content without repairing files or resolving credentials, checks the confirmed hash, and sends the snapshot to the Go lifecycle writer. Publication is not deployment activation or an evaluation result.

Snapshots identify their source as `saved_agent_configuration.v1`, retain instruction files and skill references, and fingerprint compatibility runtime configuration. The compatibility executor rejects configuration drift at dispatch and verifies instruction content before invocation. It does not restore live settings, credentials, permissions, or mutable external skill content. Director chat remains an explicitly separate saved-behavior path, not a deployment-bound delivery executor.

Deployments may select a same-workspace registered local project workspace. The Go writer resolves its path when creating a revision. The immutable revision retains that path for subsequent execution and rollback. Existing direct-path API clients remain compatible. Remote workspace provisioning and task-dependent environment inheritance are outside this path.

## Consequences

Users publish the configuration they inspect without re-entering it. The confirmed snapshot represents the read-time saved configuration; subsequent edits do not rewrite it. Stale confirmations fail with 409. Configuration drift prevents compatibility execution rather than silently running unpublished behavior. Historical versions are inspectable, but full hermetic runtime restoration requires a separate packaged-runtime contract.
