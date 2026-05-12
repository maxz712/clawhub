// Command git-service is the standalone git tier for ClawHub.
//
// It serves git Smart HTTP (receive-pack, upload-pack, info/refs) for repos
// owned by this shard. Today it execs `git http-backend` like the Node API;
// the seam exists so we can replace that path with go-git or libgit2 without
// touching the rest of the system.
//
// Auth: a static bearer token in CLAWHUB_GIT_SERVICE_TOKEN, expected to be
// proxied through by the Node router after it verifies the agent JWT. This
// is intentionally minimal — the router is the trust boundary.
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
)

func main() {
	cfg, err := internal.LoadConfigFromEnv()
	if err != nil {
		log.Fatalf("git-service: bad config: %v", err)
	}

	router := internal.NewRouter(cfg)
	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("git-service: listening on %s (repos at %s)\n", cfg.ListenAddr, cfg.ReposBasePath)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("git-service: serve error: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "git-service: shutdown error: %v\n", err)
		os.Exit(1)
	}
}
