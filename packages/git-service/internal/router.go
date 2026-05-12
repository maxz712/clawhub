package internal

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
)

type Router struct {
	cfg *Config
}

func NewRouter(cfg *Config) *Router {
	return &Router{cfg: cfg}
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

	ns, repo, suffix, ok := parseGitPath(req.URL.Path)
	if !ok {
		http.NotFound(w, req)
		return
	}

	repoDir := filepath.Join(r.cfg.ReposBasePath, ns, repo+".git")
	switch {
	case suffix == "info/refs" && req.Method == http.MethodGet,
		suffix == "git-upload-pack" && req.Method == http.MethodPost,
		suffix == "git-receive-pack" && req.Method == http.MethodPost:
		ProxyToGitBackend(w, req, repoDir, "/"+suffix)
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
