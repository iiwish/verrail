package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/verrail/verrail/services/domain-api/internal/orchestration"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	config, err := orchestration.LoadRuntimeConfig()
	if err != nil {
		logger.Error("configure orchestration worker", "error", err)
		os.Exit(1)
	}

	stop, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	pool, err := pgxpool.New(stop, config.DatabaseURL)
	if err != nil {
		logger.Error("configure orchestration database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	connectCtx, connectCancel := context.WithTimeout(stop, 10*time.Second)
	if err := pool.Ping(connectCtx); err != nil {
		connectCancel()
		logger.Error("connect orchestration database", "error", err)
		os.Exit(1)
	}
	connectCancel()

	temporalConnectCtx, temporalConnectCancel := context.WithTimeout(stop, 10*time.Second)
	temporalClient, err := client.DialContext(temporalConnectCtx, config.TemporalClientOptions())
	temporalConnectCancel()
	if err != nil {
		logger.Error("connect Temporal", "error", err, "address", config.TemporalAddress, "namespace", config.TemporalNamespace)
		os.Exit(1)
	}
	defer temporalClient.Close()

	temporalWorker := worker.New(temporalClient, config.TaskQueue, worker.Options{})
	temporalWorker.RegisterWorkflowWithOptions(orchestration.TargetWorkflow, workflow.RegisterOptions{Name: orchestration.TargetWorkflowName})
	temporalWorker.RegisterWorkflowWithOptions(orchestration.RunWorkflow, workflow.RegisterOptions{Name: orchestration.RunWorkflowName})
	if err := temporalWorker.Start(); err != nil {
		logger.Error("start Temporal worker", "error", err)
		os.Exit(1)
	}
	defer temporalWorker.Stop()

	dispatcher := orchestration.NewDispatcher(
		orchestration.NewPostgresOutboxStore(pool),
		orchestration.NewTemporalDeliverer(temporalClient, config.TaskQueue),
		orchestration.DispatcherConfig{
			LeaseDuration: config.LeaseDuration,
			MaxAttempts:   config.MaxAttempts,
			BackoffBase:   config.BackoffBase,
			BackoffMax:    config.BackoffMax,
		},
	)
	logger.Info("Verrail orchestration worker started",
		"temporalAddress", config.TemporalAddress,
		"namespace", config.TemporalNamespace,
		"taskQueue", config.TaskQueue,
	)
	runDispatcher(stop, dispatcher, config.PollInterval, logger)
}

func runDispatcher(ctx context.Context, dispatcher *orchestration.Dispatcher, pollInterval time.Duration, logger *slog.Logger) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}

		processed, err := dispatcher.ProcessOne(ctx)
		if err != nil && ctx.Err() == nil {
			logger.Error("dispatch outbox event", "error", err)
		}
		delay := pollInterval
		if processed && err == nil {
			delay = 0
		}
		timer.Reset(delay)
	}
}
