# T003 Technical Review

Reviewer: Codex under delegated intermediate technical authority

This is an engineering dependency review, not a product DeliveryReview,
ActionApproval, Acceptance, release approval, or final Outcome Owner decision.

## Authority Matrix

| Operation | User | Agent | Service | Boundary |
| --- | --- | --- | --- | --- |
| Create Submission | allow | allow | allow | candidate validator |
| Create ActionRequest | allow | allow | allow | candidate validator |
| Record DeliveryReview | allow | deny | deny | human validator and route |
| Approve ActionRequest | allow | deny | deny | human validator and route |
| Accept Submission | owner user only | deny | deny | human validator and owner check |

## Findings

No Critical or High findings remain.

- Principal identity is carried only in trusted actor context and internal
  headers. Both TypeScript Zod and Go JSON decoders reject body identity fields.
- An Agent is checked against the addressed Workspace in both the facade and
  Go persistence boundary. A Service is accepted only behind the internal
  Domain API bearer boundary and against an active Workspace.
- Lifecycle idempotency includes principal type, preventing a user and service
  with the same textual id from sharing a receipt key.
- Existing user self-review, self-approval, and non-owner acceptance tests are
  unchanged and pass. A Service-authored candidate can be reviewed, approved,
  and accepted by one authenticated human because the candidate principal is
  distinct.

Residual risk: Service identity is trusted at the internal Domain API bearer
boundary rather than registered as a database membership. This matches the
current internal-service trust model; rotating to per-service credentials is
outside T003 and should be handled with the broader credential lifecycle.

Recommendation: accept T003 for dependency progression.

