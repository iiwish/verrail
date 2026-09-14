# ADR 0014: Single Effective Agent Version

Status: Accepted

## Decision

An AgentDefinition has at most one primary Deployment, enforced by a partial unique database index. The first activation creates that identity; subsequent activation, update, resume and rollback append revisions to it. Commands require a passing version-bound evaluation and safety result. Updates require the observed primary identity and revision ID. Historical deployments cannot be adopted. Concurrent or stale writes return 409 without changing the effective version.

Published `saved_agent_configuration.v2` snapshots contain behavior settings, instruction file bytes and pinned workspace skill version references. Credentials, grants, budgets and host settings remain live. Director chat reads the effective version's prompt, runtime and model at request start and records version/revision identity on the reply. Compatibility execution materializes the pinned instructions in a private temporary directory and merges only versioned behavior into current authority-bearing settings. Provider sessions do not resume draft or other-version system instructions.

Directory selection belongs to advanced runtime settings. Activation resolves and pins the local directory in its revision. Director chat requires none. Graph nodes retain explicit immutable revision binding; new bindings and Runs require the primary active revision. Updating a version does not rewrite approved graphs or existing Run identities.

## Migration

Migration 0257 adds `is_primary=false` without activating, deleting or choosing existing rows. First activation creates a fresh primary entry and atomically retires non-primary entries and clears their default flags. Historical names are disambiguated only when they collide with the new entry name; revision identities remain unchanged. Version 1 snapshots require republication into version 2 before activation. Historical records remain inspectable; migration never claims that old external skill files or mutable host settings are recoverable. Agents without a managed AgentDefinition remain on the inherited compatibility execution path.

## Consequences

The product exposes draft, published version and effective version rather than a multi-server deployment manager. Publishing does not invoke a model, manufacture evaluation evidence or activate behavior. Rollback selects immutable behavior while current authorization still applies. This contract is configuration pinning, not a hermetic runtime image or an automatic work-graph migration.
