package target

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRunExecutorIsolationContract(t *testing.T) {
	for _, test := range []struct {
		profile, executor string
		valid             bool
	}{
		{"host_trusted", "verrail-host-runner", true},
		{"repository_sandbox", "verrail-repository-runner", true},
		{"repository_sandbox", "verrail-host-runner", false},
		{"repository_sandbox", "arbitrary-runner", false},
		{"host_trusted", "verrail-repository-runner", false},
		{"unknown", "verrail-repository-runner", false},
	} {
		t.Run(test.profile+"/"+test.executor, func(t *testing.T) {
			command := CreateRunAttemptCommand{
				WorkspaceID: "11111111-1111-4111-8111-111111111111",
				RunID:       "22222222-2222-4222-8222-222222222222",
				Principal:   Principal{Type: "user", ID: "fixture-user"}, IdempotencyKey: "fixture-attempt",
				Input: CreateRunAttemptInput{RuntimeProfile: test.profile,
					Executor: ExecutorPrincipal{PrincipalType: "service", PrincipalID: test.executor}},
			}
			err := ValidateCreateRunAttemptCommand(&command)
			if test.valid {
				require.NoError(t, err)
				require.NotEmpty(t, command.RequestHash)
			} else {
				require.Error(t, err)
			}
		})
	}
}
