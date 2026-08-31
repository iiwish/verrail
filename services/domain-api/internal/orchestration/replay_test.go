package orchestration

import (
	"io"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/require"
	temporallog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

func TestTargetWorkflowV1ReplaysCapturedHistory(t *testing.T) {
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(TargetWorkflow, workflow.RegisterOptions{Name: TargetWorkflowName})
	logger := temporallog.NewStructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, replayer.ReplayWorkflowHistoryFromJSONFile(
		logger,
		"testdata/target-workflow-v1-history.json",
	))
}
