# T014 Verification

- The preflight failure was concrete: the GitHub client replaced every PR body with only the provider marker.
- Validator coverage proves that omitted bodies normalize to an empty compatibility value and bodies over 65,536 characters fail.
- Go coverage proves that body changes alter the approval hash and that the provider payload preserves the reviewed template plus exactly one marker.
- Read-model coverage proves that the reviewed body remains visible to the approver.
- Shared, Go, server, workspace typecheck and whitespace gates passed.
