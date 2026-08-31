# B2.6 Merge Recovery & Scope Split Spec

## Problem

The accepted Verrail frontend direction is coherent in manual use, but the cumulative branch is not a trustworthy merge candidate. The complete UI suite and dedicated browser acceptance are red, the new Conversation send path can silently complete without an answer, Chinese governance controls still expose English labels, and the working diff mixes several ownership domains.

## Goal

Restore a bounded, reproducible merge path without adding product capability or revisiting the accepted information architecture.

## Context

Brand, navigation, Project-Target-Work, Agent management, Workspace simplification, Infrastructure, Governance, Settings, and Conversation work already exist on the current branch and working tree. B2.6 owns closure and separation only.

## Scope

- Repair the seven-destination Verrail navigation unit contract.
- Rewrite Project-Target-Work acceptance around the object-list project sidebar.
- Add deterministic Conversation browser acceptance using a test-only fake local runtime.
- Treat every empty conversational runtime completion as an error and cover the terminal outcome contract.
- Route governance date-range chrome through i18n.
- Produce an exhaustive scope map for the cumulative changed paths.
- Run focused and repository-wide merge validation and attach truthful evidence.

## Non-goals

- New product, domain, orchestration, agent, Temporal, Go, or release capability.
- Another navigation or domain-model redesign.
- Broad inherited Paperclip cleanup.
- Commit, PR, merge, deploy, release, or ship approval.

## Constraints

- Preserve all existing approved and user-authored work.
- Acceptance must not consume real Codex, Claude, or API credentials.
- Test-only runtime behavior must not be reachable through production configuration.
- Conversation text remains non-authoritative and cannot grant approval, acceptance, or mutation authority.
- Scope separation must describe the current diff rather than rewrite unrelated history.

## Acceptance Criteria

The criteria in `target.json` are authoritative.

## Risks

- Browser tests can become coupled to translated display text or duplicated object names.
- A fake runtime can accidentally diverge from the supported Codex JSON event contract.
- Repository-wide failures may include inherited platform-specific baseline defects.
- Physical commit splitting before the work is green would make recovery harder, so B2.6 produces reviewed ownership boundaries before any commit action.

## Open Questions

- Commit and pull-request boundaries remain a human decision after the evidence and scope map are reviewed.
