# T017 TDD Log

## RED

`TestResumeDeploymentEvaluationGateIntegration` created a valid Deployment, paused it, changed its bound test EvaluationRun to the legacy compatibility state `inconclusive/not_run`, then attempted resume. The command returned success, proving that resume bypassed production evaluation admission.

## GREEN

The resume branch now calls the existing `assertPassingEvaluation` inside the serializable transaction before changing status or inserting a Revision. The focused test receives `AGENT_EVALUATION_GATE_FAILED` and confirms the Deployment remains paused, the Revision count is unchanged, and the latest Revision state is unchanged.

## Verification

- Focused resume and retired-deployment integration tests passed.
- Complete Go Domain API suite passed.
- `gofmt` and `git diff --check` passed.
