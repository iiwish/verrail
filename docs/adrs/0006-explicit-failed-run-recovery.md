# ADR 0006: Explicit Failed Run Recovery

Status: Accepted for implementation

## Decision

A workspace member's audited outbox requeue receipt authorizes recovery of a
failed RunWorkflow. The dispatcher derives authorization from the receipt, not
from event payload content. Running Workflows receive the existing signal;
completed, canceled and terminated Workflows cannot be reopened by this command.

A recovery-mode Workflow reconstructs the current RunAttempt and lease from
PostgreSQL through a scoped Domain Activity. That Activity may expire the current
lease after its grace deadline and record the resulting failure and audit event.
It cannot create an Attempt or report an executor result. The normal explicit
retry command remains the authority for starting another Attempt.

Historical signals are wakeups, not authority to overwrite the database-derived
state. The recovery Workflow waits on active lease deadlines and notifications,
retains bounded event deduplication across Continue-As-New, and completes a
terminal Run only after its pending outbox has drained. Administrative cancellation
of this recovery observer does not issue a business cancellation command.

## Constraints

- Preserve event identity, payload, aggregate ordering and delivery counts.
- Preserve Run, TargetRevision, GraphRevision, DeploymentRevision and AgentVersion.
- Expire only the current Attempt's elapsed lease while holding Run/Attempt/Lease
  locks; stale executor events remain fenced out.
- Reopening orchestration does not increase an execution budget or allocate work.
- Existing RunWorkflow inputs retain their original execution path and history.
- Neither recovery nor retry substitutes for Review, ActionApproval or Acceptance.
