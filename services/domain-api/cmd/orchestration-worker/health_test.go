package main

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestWorkerHealthChecksDependenciesWithDeadlineAndHidesDiagnostics(t *testing.T) {
	for _, failure := range []error{nil, errors.New("private database diagnostic")} {
		handler := workerHealthHandler(func(ctx context.Context) error {
			deadline, ok := ctx.Deadline()
			require.True(t, ok)
			require.LessOrEqual(t, time.Until(deadline), 3*time.Second)
			return failure
		})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/health", nil))
		if failure == nil {
			require.Equal(t, 204, response.Code)
		} else {
			require.Equal(t, 503, response.Code)
			require.NotContains(t, response.Body.String(), failure.Error())
		}
	}
}
