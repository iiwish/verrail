# B2.5 Merge Gate Baseline Closure Spec

## Problem

The cumulative Verrail productization branch passes its focused feature checks, typecheck, affected builds, UI token gates, and browser acceptance. Repository-wide merge validation is still inconclusive because live listener diagnosis returns no result on macOS and the Skills Catalog manifest build can wait indefinitely on a remote GitHub reference.

## Goal

Make repository merge validation bounded, portable, and reproducible without adding product capability or hiding unrelated failures.

## Context

The current branch contains approved brand, navigation, Project-Target-Work, Agent, default Workspace, and Conversation work. B2.5 owns only the test and build infrastructure needed to judge that cumulative change truthfully.

## Scope

- Repair runtime listener diagnosis across supported macOS and Linux development hosts.
- Preserve wildcard-listener exposure detection for both application and HMR ports.
- Bound remote Skills Catalog reference requests and use only integrity-checked local manifest data as a build fallback.
- Add focused tests for portability, timeout, fallback, and integrity behavior.
- Run focused and repository-wide merge gates.
- Attach evidence and draft a merge-readiness decision.

## Non-goals

- New UI, domain, agent, chat, Temporal, Graph, Run, Review, or Acceptance capability.
- Broad inherited Paperclip cleanup unrelated to the confirmed gates.
- Suppressing tests, weakening security checks, or accepting stale remote content without commit and digest validation.
- Commit, push, PR, merge, deploy, or release.

## Constraints

- Preserve all existing uncommitted user and approved branch work.
- Runtime exposure checks must fail closed when they positively detect a wildcard bind.
- Network unavailability must not make local builds hang forever.
- A cached remote reference is usable only when its pinned source identity and file digests remain valid.
- Do not change Telemetry behavior.

## Acceptance Criteria

The criteria in `target.json` are authoritative.

## Risks

- Platform-specific listener commands can emit different address formats.
- An overly broad fallback could conceal an intentionally updated referenced skill.
- Full-suite failures can be contaminated by active local services or unrelated baseline defects.

## Open Questions

- Final commit and pull-request approval remains a human decision after the evidence is available.
