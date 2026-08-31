# B2.7 Scoped Commit & PR Validation Spec

## Problem

The Verrail productization work is functionally closed through B2.6, but it is not reviewable as one pull request. The branch already changes 293 committed paths and has 117 uncommitted paths. A single pull request would exceed the repository's 100-file review limit and would mix brand, domain, orchestration, frontend acceptance, runtime hardening, Conversation, and delivery evidence.

## Goal

Create a dependency-ordered pull-request stack that preserves all accepted work, keeps every review delta below 100 files, and produces remote CI evidence before any human merge decision.

## Context

The current branch contains six logical commits after `master`. B2.6 provides an exhaustive ownership map for the working tree. The branch has not been pushed. One prior commit includes a prohibited `pnpm-lock.yaml` delta and must be replayed without that file before publication.

## Scope

- Commit the B2.6 working tree by declared ownership.
- Preserve prior commits and attribution while constructing clean public branches.
- Remove the unpublished lockfile delta without losing other acceptance work.
- Keep each stacked pull request below 100 changed files.
- Use descriptive public branch names and the repository pull-request template.
- Observe remote checks, automated review, and conflict status.
- Attach a durable stack manifest and evidence bundle.

## Non-goals

- New implementation scope.
- Squashing the full productization program into one opaque commit.
- Merging, deploying, releasing, or shipping.
- Claiming green status for any check that was not observed.

## Constraints

- Existing work must not be lost.
- `pnpm-lock.yaml` must not be part of the published stack.
- Workflow changes are retained only because they implement the dedicated Verrail acceptance and release gates.
- Every pull request must use public, reviewer-readable context only.
- The active local service must be stopped before history replay and restarted after local validation.

## Acceptance Criteria

The criteria in `target.json` are authoritative.

## Risks

- Stacked pull requests can become hard to follow if bases, order, or dependencies are not explicit.
- Replaying the acceptance commit can omit a required file if the lockfile removal is not verified against the original tree.
- Remote CI can expose repository-host differences that local macOS evidence cannot reproduce.
- Later commits may overlap earlier files, so branch construction and file-count checks must use each pull request's declared base.

## Open Questions

- Final merge order and timing remain a human decision after the stack is green.
