// Command codeatlas-api runs the CodeAtlas core API server.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"codeatlas/core/internal/api"
	"codeatlas/core/internal/auth"
	"codeatlas/core/internal/clickhouse"
	"codeatlas/core/internal/config"
	"codeatlas/core/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	if err := bootstrapAdmin(ctx, st, cfg, log); err != nil {
		return err
	}

	ch := clickhouse.New(cfg.ClickHouse)
	if err := ch.EnsureDatabase(ctx); err != nil {
		// Not fatal: the static code map works without telemetry; /readyz reports it.
		log.Warn("clickhouse unavailable", "err", err)
	}

	go cleanupTokens(ctx, st, log)

	apiServer := api.New(cfg, st, ch, log)
	defer apiServer.Close() // stop analyses before the store closes
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           apiServer.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.HTTPAddr)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// bootstrapAdmin creates the first admin from env vars when no users exist yet.
func bootstrapAdmin(ctx context.Context, st *store.Store, cfg config.Config, log *slog.Logger) error {
	n, err := st.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if cfg.AdminEmail == "" {
		log.Warn("no users exist; set CODEATLAS_ADMIN_EMAIL and CODEATLAS_ADMIN_PASSWORD to create the first admin")
		return nil
	}
	hash, err := auth.HashPassword(cfg.AdminPassword)
	if err != nil {
		return err
	}
	if _, err := st.CreateUser(ctx, cfg.AdminEmail, hash, store.RoleAdmin); err != nil && !errors.Is(err, store.ErrConflict) {
		return err
	}
	log.Info("created bootstrap admin", "email", cfg.AdminEmail)
	return nil
}

func cleanupTokens(ctx context.Context, st *store.Store, log *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := st.DeleteExpiredTokens(ctx); err != nil {
				log.Warn("token cleanup failed", "err", err)
			} else if n > 0 {
				log.Info("removed expired sessions", "count", n)
			}
		}
	}
}
