package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/verrail/verrail/services/domain-api/internal/httpapi"
	"github.com/verrail/verrail/services/domain-api/internal/target"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	token := strings.TrimSpace(os.Getenv("VERRAIL_DOMAIN_API_TOKEN"))
	address := strings.TrimSpace(os.Getenv("VERRAIL_DOMAIN_API_LISTEN"))
	if address == "" {
		address = "127.0.0.1:3211"
	}
	if databaseURL == "" || token == "" {
		logger.Error("DATABASE_URL and VERRAIL_DOMAIN_API_TOKEN are required")
		os.Exit(1)
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		logger.Error("configure database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := pool.Ping(ctx); err != nil {
		cancel()
		logger.Error("connect database", "error", err)
		os.Exit(1)
	}
	cancel()

	server := &http.Server{
		Addr:              address,
		Handler:           httpapi.New(token, target.NewStore(pool), logger),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	stop, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	go func() {
		logger.Info("Verrail Domain API listening", "address", address)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("serve Domain API", "error", err)
			os.Exit(1)
		}
	}()
	<-stop.Done()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown Domain API", "error", err)
	}
}
