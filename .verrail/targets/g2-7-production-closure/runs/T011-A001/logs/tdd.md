# T011 TDD Log

## RED

The full suite and first isolated rerun both reproduced a concurrent max-turn continuation failure:
one caller scheduled the retry while the duplicate returned `issue_execution_lock_changed` before
it could observe the matching continuation.

## GREEN

Scheduling preflight no longer enforces the mutable execution lock. The serialized transaction
locks the issue, reuses an exact matching live continuation, and only then rejects a changed lock
when no match exists.

## REFACTOR

Retry promotion was left unchanged. Its execution-lock check remains necessary because promotion
must prove that the specific due retry still owns the issue.

## Verification

The coalescing and changed-lock cases passed together in five fresh runs. The complete 31-test file,
server typecheck and whitespace check passed.
