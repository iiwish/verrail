# G2.4 Independent Engineering Review — disposition

Reviewers: two independent review slices (backend adjudication semantics /
transaction integrity / authority enforcement; facade contract sync / read
model derived validity / UI honesty). No P0 found.

## Findings and dispositions

### Fixed during this review

1. **P1 — Reviewer identity was self-attested.** The "human workspace member"
   half of the confirmed authority model was unenforced end-to-end: the
   reviewer principal arrived on the wire, the facade passed the body through,
   and the Go store checked only reviewer != submitter. A submitter could
   record an approved review attributed to any principal string, making the
   independence gate forgeable through the public surface (the acceptance
   itself remained owner-gated). FIXED: the store now binds the reviewer wire
   field to the authenticated command principal (403
   ADJUDICATION_REVIEWER_FORBIDDEN) before the independence check; spec.md
   authority model updated ("the reviewer is the authenticated human member
   recording the review"); integration subtest "reviewer identity must be the
   authenticated principal" added (fabricated reviewer rejected; 8 subtests
   total, all passing on a real database).

### Recorded as follow-ups

- **P3** — Submission content-hash race under concurrent identical
  submissions surfaces as 409 ADJUDICATION_SUBMISSION_DUPLICATE rather than
  replay (sequential dedup replays correctly); retry with a new key recovers.
- **P3** — acceptance_hash binds review/submission/revision/authority but not
  accepted_by (one acceptance per submission makes the accepter derivable).
- **P3** — claim status transitions remain unrestricted (a later passed
  result can flip a waived claim); formalize when G2.5 wires CI evidence.
- **P3** — nil vs empty array request-hash asymmetry (waived verdict retried
  with omitted vs empty evidenceIds conflicts instead of replaying).
- **P3** — facade validator stricter than Go on null/omitted list fields
  (unprovenItems required at the facade; explicit null
  verificationResultIds rejected at the facade, accepted by Go); stricter-at-
  edge is the defensible posture, recorded for contract parity.
- **P3** — workspace() derived validity compares against the requested
  revision when reached through a revision-filtered read path; the only
  current caller is the targetId route, so the edge is latent.
- **P3** — Go integration derived-validity blocks use constant booleans for
  two of the three cases; the real wiring is covered end-to-end by the TS
  read-model tests against an embedded database (superseded, revision-
  changed, and the both-changed precedence case).
- **P3 (UI)** — invalid acceptance tone is warning (consistent with the
  page's changes_requested/waived convention; a judgment call, token-clean).
- **P3 (UI)** — ToneBadge re-creates badge styling instead of composing the
  Badge primitive; consistent with the StatusBadge precedent.

## Verdict per acceptance criterion (post-fix)

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Immutable submission set snapshots | SATISFIED (hash-bound, dedup replay, no update paths) |
| 2 | Independent append-only reviews | SATISFIED (after fix: reviewer = authenticated member, != submitter) |
| 3 | Acceptance requires approved review + outcome-owner authority | SATISFIED (409/403 enforced and tested) |
| 4 | Derived invalid acceptance visible without mutating facts | SATISFIED (pure projection; TS read-model tests prove superseded/revision-changed/precedence end-to-end) |
| 5 | Contracts synchronized and verified | SATISFIED (migration reconcilable, Go integration covers the full path, facade/UI tests pass, i18n parity holds) |

**Recommendation: approvable.** Immutability, hash binding, the receipt+
audit transaction pattern, race handling, and derived invalidation are
correct; the one authority gap is fixed and regression-tested.

## Review boundary

Independent engineering review only. Product acceptance, merge, deployment,
release, and ship authority remain with the Outcome Owner.
