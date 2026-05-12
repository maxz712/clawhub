// Command git-service is the standalone git tier for ClawHub.
//
// It serves two transports for the same operations:
//
//   - HTTP (`:9000` default) — Smart HTTP for git clients
//     (`info/refs`, `git-{receive,upload}-pack`) plus the JSON internal API
//     consumed by older Node clients. Always enabled.
//   - gRPC (`:9001` default)  — the GitService surface defined in
//     `proto/git.proto`. Enabled when `CLAWHUB_GRPC_ADDR` is set (the
//     Helm chart sets it by default; standalone builds opt in).
//
// Both transports authenticate via the shared bearer token in
// `CLAWHUB_GIT_SERVICE_TOKEN`. The Node router picks which to use via
// `CLAWHUB_TRANSPORT=grpc|http`.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/clawhub/git-service/internal"
	"github.com/clawhub/git-service/internal/gitops"
	"github.com/clawhub/git-service/internal/grpcserver"
)

func main() {
	cfg, err := internal.LoadConfigFromEnv()
	if err != nil {
		log.Fatalf("git-service: bad config: %v", err)
	}

	// One backend, shared by both transports.
	ops, err := gitops.New()
	if err != nil {
		log.Fatalf("git-service: gitops: %v", err)
	}

	router := internal.NewRouter(cfg, ops)
	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("git-service: http listening on %s (repos at %s)\n", cfg.ListenAddr, cfg.ReposBasePath)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("git-service: http serve error: %v", err)
		}
	}()

	var grpcSrv stopper
	if cfg.GrpcAddr != "" {
		srv, err := grpcserver.Listen(cfg.GrpcAddr, cfg, ops)
		if err != nil {
			log.Fatalf("git-service: grpc serve error: %v", err)
		}
		log.Printf("git-service: grpc listening on %s (backend=%s)\n", cfg.GrpcAddr, ops.Backend())
		grpcSrv = grpcStopper{srv: srv}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if grpcSrv != nil {
		grpcSrv.GracefulStop()
	}
	if err := httpServer.Shutdown(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "git-service: shutdown error: %v\n", err)
		os.Exit(1)
	}
}

// stopper is a tiny indirection so the binary still builds when the gRPC
// server isn't constructed (CLAWHUB_GRPC_ADDR unset). The real
// implementation is grpc.Server.GracefulStop.
type stopper interface{ GracefulStop() }

type grpcStopper struct{ srv interface{ GracefulStop() } }

func (g grpcStopper) GracefulStop() { g.srv.GracefulStop() }
