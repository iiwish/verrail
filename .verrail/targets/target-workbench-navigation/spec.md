# Target Workbench Navigation

## Scope

Workbench combines graph inspection, attention, contextual commands, expandable
goal details, stage progress, and all-run controls. Delivery distinguishes working
artifacts from immutable submission candidates. Activity exposes meaningful
changes with expandable audit payloads and grouped routine records.

## Constraints

- Keep all command requests, actor attribution, and idempotency behavior bound to
  server-projected resources. Review, acceptance, and external approval are distinct.
- Candidate views use submission-bound artifact and verification IDs, not current
  claim status. Historical criteria use the immutable TargetRevision link.
- Never treat candidate acceptance as final Target Outcome acceptance.
- Use existing UI tokens and English/Chinese locale keys.
- Preserve old routes and existing runtime/evidence files outside this task.

## Verification

Focused tests cover legacy navigation, immutable views, command bindings, retries,
candidate selection, audit grouping, and bounded plain-text preview. Browser checks
use existing local data without issuing review, acceptance, execution, or approval.

## Remaining Gates

Human review and a complete repository-wide test run are separate from this UI
implementation checkpoint. No release or ship approval is implied.

This record is attached after implementation; it is not a pre-execution approval.
