package orchestration

import (
	"crypto/tls"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLoadRuntimeConfigDefaultsAndOverrides(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://verrail:test@localhost/verrail")
	t.Setenv("TEMPORAL_ADDRESS", "temporal.internal:7233")
	t.Setenv("VERRAIL_OUTBOX_POLL_INTERVAL", "500ms")
	t.Setenv("VERRAIL_OUTBOX_MAX_ATTEMPTS", "12")

	config, err := LoadRuntimeConfig()

	require.NoError(t, err)
	require.Equal(t, "temporal.internal:7233", config.TemporalAddress)
	require.Equal(t, "default", config.TemporalNamespace)
	require.Equal(t, DefaultTargetTaskQueue, config.TaskQueue)
	require.Equal(t, 500*time.Millisecond, config.PollInterval)
	require.Equal(t, 12, config.MaxAttempts)
}

func TestLoadRuntimeConfigFailsClosed(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	_, err := LoadRuntimeConfig()
	require.EqualError(t, err, "DATABASE_URL is required")

	t.Setenv("DATABASE_URL", "postgres://verrail:test@localhost/verrail")
	t.Setenv("VERRAIL_OUTBOX_LEASE_DURATION", "forever")
	_, err = LoadRuntimeConfig()
	require.EqualError(t, err, "VERRAIL_OUTBOX_LEASE_DURATION must be a positive Go duration")
}

func TestTemporalAPIKeyAlwaysEnablesTLS(t *testing.T) {
	config := RuntimeConfig{
		TemporalAddress:   "namespace.tmprl.cloud:7233",
		TemporalNamespace: "namespace.account",
		TemporalAPIKey:    "secret",
	}

	options := config.TemporalClientOptions()

	require.NotNil(t, options.Credentials)
	require.NotNil(t, options.ConnectionOptions.TLS)
	require.Equal(t, uint16(tls.VersionTLS12), options.ConnectionOptions.TLS.MinVersion)
}
