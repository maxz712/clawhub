package internal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// POST /internal/repos/fetch-pack
//
// Build a packfile containing exactly the requested object SHAs (and their
// reachable history). The replication tailer and migration tool both use
// this to pull objects between shards without a full clone.
type fetchPackBody struct {
	Namespace string   `json:"namespace"`
	Name      string   `json:"name"`
	Wants     []string `json:"wants"`
}

func (r *Router) handleFetchPack(w http.ResponseWriter, req *http.Request) {
	var body fetchPackBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !repo.Exists(r.cfg.ReposBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "repo_not_found"})
		return
	}
	if len(body.Wants) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no_wants"})
		return
	}

	// Feed wants on stdin to `git pack-objects --stdout --revs`, which writes
	// a packfile to stdout. We pass `--no-reuse-delta` only when explicitly
	// requested by the caller (not yet exposed); defaults to delta-compressed.
	stdin := strings.Join(body.Wants, "\n") + "\n"
	pack, err := runGitStdinBytes(req.Context(), repo.Path(r.cfg.ReposBasePath), []byte(stdin),
		"pack-objects", "--stdout", "--revs", "--thin")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	w.Header().Set("content-type", "application/x-git-packed-objects")
	w.Header().Set("content-length", strconv.Itoa(len(pack)))
	if _, err := w.Write(pack); err != nil {
		return
	}
}

// POST /internal/repos/apply-pack
//
// Read a packfile from the request body and apply it via `git index-pack
// --stdin --fix-thin`. Used by the replication tailer to install objects
// fetched from the primary.
func (r *Router) handleApplyPack(w http.ResponseWriter, req *http.Request) {
	header := req.Header.Get("x-clawhub-repo")
	parts := strings.SplitN(header, "/", 2)
	if len(parts) != 2 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing_x-clawhub-repo"})
		return
	}
	repo := Repo{Namespace: parts[0], Name: parts[1]}
	if !repo.Exists(r.cfg.ReposBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "repo_not_found"})
		return
	}
	pack, err := io.ReadAll(req.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "read_body: " + err.Error()})
		return
	}
	if _, err := runGitWithStdin(req.Context(), repo.Path(r.cfg.ReposBasePath), pack,
		"index-pack", "--stdin", "--fix-thin"); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// runGitStdinBytes is the bytes-clean variant used for binary packfiles. It
// avoids the string round-trip from `runGitWithStdin`.
func runGitStdinBytes(ctx context.Context, dir string, stdin []byte, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Stdin = bytes.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w (stderr=%s)", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

var _ = io.Discard // keep io import in case future endpoints need it
