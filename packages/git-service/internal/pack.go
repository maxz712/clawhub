package internal

import (
	"encoding/json"
	"net/http"
	"strings"
)

// POST /internal/repos/fetch-pack
//
// Build a packfile containing exactly the requested object SHAs (and their
// reachable history) and stream it to the response. The replication tailer
// and migration tool both use this to pull objects between shards.
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
	if len(body.Wants) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no_wants"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !validateRepo(w, repo) { // path-traversal guard
		return
	}
	w.Header().Set("Content-Type", "application/x-git-packed-objects")
	if err := r.ops.FetchPack(req.Context(), repo.Path(r.cfg.ReposBasePath), body.Wants, w); err != nil {
		writeOpsErr(w, err)
	}
}

// POST /internal/repos/apply-pack
//
// Read a packfile from the request body and install the objects.
func (r *Router) handleApplyPack(w http.ResponseWriter, req *http.Request) {
	header := req.Header.Get("x-clawhub-repo")
	parts := strings.SplitN(header, "/", 2)
	if len(parts) != 2 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing_x-clawhub-repo"})
		return
	}
	repo := Repo{Namespace: parts[0], Name: parts[1]}
	if !validateRepo(w, repo) { // path-traversal guard
		return
	}
	if err := r.ops.ApplyPack(req.Context(), repo.Path(r.cfg.ReposBasePath), req.Body); err != nil {
		writeOpsErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
