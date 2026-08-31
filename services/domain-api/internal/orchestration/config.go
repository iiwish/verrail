package orchestration

import (
	"crypto/tls"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"go.temporal.io/sdk/client"
)

type RuntimeConfig struct {
	DatabaseURL       string
	TemporalAddress   string
	TemporalNamespace string
	TemporalAPIKey    string
	TLSServerName     string
	TaskQueue         string
	PollInterval      time.Duration
	LeaseDuration     time.Duration
	MaxAttempts       int
	BackoffBase       time.Duration
	BackoffMax        time.Duration
}

func LoadRuntimeConfig() (RuntimeConfig, error) {
	config := RuntimeConfig{
		DatabaseURL:       strings.TrimSpace(os.Getenv("DATABASE_URL")),
		TemporalAddress:   envOrDefault("TEMPORAL_ADDRESS", "127.0.0.1:7233"),
		TemporalNamespace: envOrDefault("TEMPORAL_NAMESPACE", "default"),
		TemporalAPIKey:    strings.TrimSpace(os.Getenv("TEMPORAL_API_KEY")),
		TLSServerName:     strings.TrimSpace(os.Getenv("TEMPORAL_TLS_SERVER_NAME")),
		TaskQueue:         envOrDefault("VERRAIL_TEMPORAL_TASK_QUEUE", DefaultTargetTaskQueue),
		PollInterval:      250 * time.Millisecond,
		LeaseDuration:     30 * time.Second,
		MaxAttempts:       8,
		BackoffBase:       time.Second,
		BackoffMax:        time.Minute,
	}
	if config.DatabaseURL == "" {
		return RuntimeConfig{}, fmt.Errorf("DATABASE_URL is required")
	}
	var err error
	if config.PollInterval, err = durationFromEnv("VERRAIL_OUTBOX_POLL_INTERVAL", config.PollInterval); err != nil {
		return RuntimeConfig{}, err
	}
	if config.LeaseDuration, err = durationFromEnv("VERRAIL_OUTBOX_LEASE_DURATION", config.LeaseDuration); err != nil {
		return RuntimeConfig{}, err
	}
	if config.BackoffBase, err = durationFromEnv("VERRAIL_OUTBOX_BACKOFF_BASE", config.BackoffBase); err != nil {
		return RuntimeConfig{}, err
	}
	if config.BackoffMax, err = durationFromEnv("VERRAIL_OUTBOX_BACKOFF_MAX", config.BackoffMax); err != nil {
		return RuntimeConfig{}, err
	}
	if value := strings.TrimSpace(os.Getenv("VERRAIL_OUTBOX_MAX_ATTEMPTS")); value != "" {
		config.MaxAttempts, err = strconv.Atoi(value)
		if err != nil || config.MaxAttempts < 1 {
			return RuntimeConfig{}, fmt.Errorf("VERRAIL_OUTBOX_MAX_ATTEMPTS must be a positive integer")
		}
	}
	if config.BackoffMax < config.BackoffBase {
		return RuntimeConfig{}, fmt.Errorf("VERRAIL_OUTBOX_BACKOFF_MAX must not be shorter than VERRAIL_OUTBOX_BACKOFF_BASE")
	}
	return config, nil
}

func (config RuntimeConfig) TemporalClientOptions() client.Options {
	options := client.Options{
		HostPort:  config.TemporalAddress,
		Namespace: config.TemporalNamespace,
	}
	if config.TemporalAPIKey != "" {
		options.Credentials = client.NewAPIKeyStaticCredentials(config.TemporalAPIKey)
	}
	if config.TemporalAPIKey != "" || config.TLSServerName != "" {
		options.ConnectionOptions.TLS = &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: config.TLSServerName,
		}
	}
	return options
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func durationFromEnv(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("%s must be a positive Go duration", name)
	}
	return duration, nil
}
