package internal

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
)

// POST /internal/repos/mirror-clone
//
// Pull a full mirror clone from another shard into this shard. Used by the
// migration controller (`shard-migration.ts`) to seed a destination shard
// before tailing the WAL for catch-up.
type mirrorBody struct {
	Namespace    string `json:"namespace"`
	Name         string `json:"name"`
	FromEndpoint string `json:"fromEndpoint"`
}

func (r *Router) handleMirrorClone(w http.ResponseWriter, req *http.Request) {
	var body mirrorBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if body.Namespace == "" || body.Name == "" || body.FromEndpoint == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing_fields"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !validateRepo(w, repo) { // path-traversal guard before clone target is built
		return
	}
	dir := repo.Path(r.cfg.ReposBasePath)

	// Make sure the parent directory exists; clone into a brand-new bare repo.
	if err := os.MkdirAll(repo.parentDir(r.cfg.ReposBasePath), 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "mkdir: " + err.Error()})
		return
	}
	if _, err := os.Stat(dir); err == nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "already_exists"})
		return
	}

	url := body.FromEndpoint + "/" + body.Namespace + "/" + body.Name + ".git"
	cmd := exec.CommandContext(req.Context(), "git", "clone", "--bare", "--mirror", url, dir)
	// Inject the inter-shard bearer token via an http extraheader.
	if r.cfg.SharedToken != "" {
		cmd.Env = append(os.Environ(), `GIT_CONFIG_COUNT=1`,
			`GIT_CONFIG_KEY_0=http.extraheader`,
			"GIT_CONFIG_VALUE_0=Authorization: Bearer "+r.cfg.SharedToken,
		)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error":  "clone_failed: " + err.Error(),
			"detail": string(out),
		})
		return
	}
	if err := installPreReceiveHook(dir, r.cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "hook_install: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": dir})
}

// helper used above: ensure parent (namespace) dir exists
func (r Repo) parentDir(base string) string {
	return filepath.Join(base, r.Namespace)
}
