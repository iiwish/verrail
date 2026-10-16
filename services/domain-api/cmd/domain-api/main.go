package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
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
	profile := strings.TrimSpace(os.Getenv("VERRAIL_EXECUTOR_RUNTIME_PROFILE"))
	if profile != "" && profile != "host_trusted" && profile != "repository_sandbox" {
		logger.Error("Invalid executor runtime profile")
		os.Exit(1)
	}
	// Validate optional proof trust before connecting. No secret/config value is logged.
	proofToken, proofProfile := os.Getenv("VERRAIL_GITHUB_CI_PROOF_TOKEN"), os.Getenv("VERRAIL_GITHUB_CI_PROOF_TRUST")
	deliveryProfile := os.Getenv("VERRAIL_DELIVERY_PROOF_TRUST")
	if filename := os.Getenv("VERRAIL_DELIVERY_PROOF_TRUST_FILE"); filename != "" {
		if deliveryProfile != "" || !filepath.IsAbs(filename) {
			logger.Error("DELIVERY_PROOF_CONFIG_INVALID")
			os.Exit(1)
		}
		file, err := os.OpenFile(filename, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			logger.Error("DELIVERY_PROOF_CONFIG_INVALID")
			os.Exit(1)
		}
		raw, err := io.ReadAll(io.LimitReader(file, 16385))
		_ = file.Close()
		if err != nil || len(raw) > 16384 {
			logger.Error("DELIVERY_PROOF_CONFIG_INVALID")
			os.Exit(1)
		}
		deliveryProfile = string(raw)
	}
	if _, err := httpapi.ConfigureDeliveryProof(deliveryProfile, nil); err != nil {
		logger.Error("DELIVERY_PROOF_CONFIG_INVALID")
		os.Exit(1)
	}
	if _, err := httpapi.ConfigureFixedCIProof(token, proofToken, proofProfile, nil); err != nil {
		logger.Error("FIXED_CI_PROOF_CONFIG_INVALID")
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
	var storeOptions []target.StoreOption
	if profile == "repository_sandbox" {
		storeOptions = append(storeOptions, target.WithRequiredRepositorySource())
	}
	store := target.NewStore(pool, storeOptions...)
	proof, err := httpapi.ConfigureFixedCIProof(token, proofToken, proofProfile, store)
	if err != nil {
		logger.Error("FIXED_CI_PROOF_CONFIG_INVALID")
		os.Exit(1)
	}
	delivery, err := httpapi.ConfigureDeliveryProof(deliveryProfile, store)
	if err != nil {
		logger.Error("DELIVERY_PROOF_CONFIG_INVALID")
		os.Exit(1)
	}

	server := &http.Server{
		Addr:              address,
		Handler:           httpapi.NewWithProofVerifiers(token, store, logger, proof, delivery),
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
