package internal

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/clawhub/git-service/internal/gitops"
)

type Router struct {
	cfg *Config
	ops gitops.Ops
}

func NewRouter(cfg *Config) *Router {
	ops, err := gitops.New()
	if err != nil {
		log.Fatalf("gitops: %v", err)
	}
	log.Printf("git-service: backend=%s", ops.Backend())
	return &Router{cfg: cfg, ops: ops}
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	switch req.URL.Path {
	case "/healthz":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "shard": r.cfg.ShardID})
		return
	case "/readyz":
		writeJSON(w, http.StatusOK, map[string]any{"ready": true, "shard": r.cfg.ShardID})
		return
	}

	if !r.authorized(req) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "unauthorized"})
		return
	}

	// Internal API for the Node router. See `packages/api/src/services/git-client.ts`.
	switch req.URL.Path {
	case "/internal/repos/init":
		if req.Method != http.MethodPost { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleInit(w, req); return
	case "/internal/repos/refs":
		if req.Method != http.MethodGet { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleListRefs(w, req); return
	case "/internal/repos/update-ref":
		if req.Method != http.MethodPost { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleUpdateRef(w, req); return
	case "/internal/repos/delete-ref":
		if req.Method != http.MethodPost { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleDeleteRef(w, req); return
	case "/internal/repos/resolve-ref":
		if req.Method != http.MethodGet { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleResolveRef(w, req); return
	case "/internal/repos/merge":
		if req.Method != http.MethodPost { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleMerge(w, req); return
	case "/internal/repos/fetch-pack":
		if req.Method != http.MethodPost { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleFetchPack(w, req); return
	case "/internal/repos/apply-pack":
		if req.Method != http.MethodPost { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleApplyPack(w, req); return
	case "/internal/repos/mirror-clone":
		if req.Method != http.MethodPost { http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed); return }
		r.handleMirrorClone(w, req); return
	}

	ns, repo, suffix, ok := parseGitPath(req.URL.Path)
	if !ok {
		http.NotFound(w, req)
		return
	}

	repoDir := filepath.Join(r.cfg.ReposBasePath, ns, repo+".git")
	switch {
	case suffix == "info/refs" && req.Method == http.MethodGet:
		serveInfoRefs(w, req, repoDir)
	case suffix == "git-upload-pack" && req.Method == http.MethodPost:
		servePackProcess(w, req, repoDir, "upload-pack")
	case suffix == "git-receive-pack" && req.Method == http.MethodPost:
		servePackProcess(w, req, repoDir, "receive-pack")
	default:
		http.NotFound(w, req)
	}
}

func parseGitPath(p string) (ns, repo, suffix string, ok bool) {
	parts := strings.SplitN(strings.TrimPrefix(p, "/"), "/", 3)
	if len(parts) < 3 {
		return "", "", "", false
	}
	if !strings.HasSuffix(parts[1], ".git") {
		return "", "", "", false
	}
	return parts[0], strings.TrimSuffix(parts[1], ".git"), parts[2], true
}

func (r *Router) authorized(req *http.Request) bool {
	h := req.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	got := []byte(strings.TrimPrefix(h, prefix))
	want := []byte(r.cfg.SharedToken)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
