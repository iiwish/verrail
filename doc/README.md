# Inherited implementation references

`doc/` contains operational and implementation material for the TypeScript
foundation currently present in this repository. These documents explain code
that still runs; they do not define Verrail's product direction.

Read the canonical Verrail documents in [`docs/README.md`](../docs/README.md)
before using anything in this directory.

## Retained groups

- Development, database, Docker, installation, deployment modes, CLI, secrets,
  observability, run logs, and execution semantics;
- Adapter, Runner, workspace, MCP, Connector, low-trust, and plugin references;
- The inherited V1 implementation contract where current API and schema behavior
  still needs a compatibility reference;
- UI component and token implementation guidance.

## Rules

- Product scope, terminology, ontology, target architecture, and roadmap live in
  `docs/` only.
- Files here may retain `Paperclip`, `company`, `issue`, `board`, and
  `heartbeat` while the corresponding implementation exists.
- New Verrail behavior must not be specified here first.
- When a migrated module no longer uses an inherited behavior, update or remove
  its reference in the same change.
- Historical plans, release marketing, PR screenshots, AI-company narratives,
  and obsolete design prompts do not belong in this directory.
