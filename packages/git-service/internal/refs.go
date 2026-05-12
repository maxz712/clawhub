package internal

import (
	"encoding/json"
	"net/http"
	"strings"
)

type refRow struct {
	RefName string `json:"refName"`
	Sha     string `json:"sha"`
}

// GET /internal/repos/refs?namespace=&name=&prefix=
func (r *Router) handleListRefs(w http.ResponseWriter, req *http.Request) {
	q := req.URL.Query()
	repo := Repo{Namespace: q.Get("namespace"), Name: q.Get("name")}
	prefix := q.Get("prefix")
	if prefix == "" {
		prefix = "refs/"
	}
	if !repo.Exists(r.cfg.ReposBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "repo_not_found"})
		return
	}
	out, err := runGit(req.Context(), repo.Path(r.cfg.ReposBasePath), "for-each-ref", "--format=%(refname) %(objectname)", prefix)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	refs := []refRow{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		if len(parts) != 2 {
			continue
		}
		refs = append(refs, refRow{RefName: parts[0], Sha: parts[1]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"refs": refs})
}

// POST /internal/repos/update-ref
type updateRefBody struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	RefName   string `json:"refName"`
	OldSha    string `json:"oldSha"`
	NewSha    string `json:"newSha"`
}

func (r *Router) handleUpdateRef(w http.ResponseWriter, req *http.Request) {
	var body updateRefBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !repo.Exists(r.cfg.ReposBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "repo_not_found"})
		return
	}
	args := []string{"update-ref", body.RefName, body.NewSha}
	if body.OldSha != "" && !isZero(body.OldSha) {
		args = append(args, body.OldSha)
	}
	if _, err := runGit(req.Context(), repo.Path(r.cfg.ReposBasePath), args...); err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "is not a valid ref") || strings.Contains(err.Error(), "cannot lock ref") {
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /internal/repos/delete-ref
type deleteRefBody struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	RefName   string `json:"refName"`
}

func (r *Router) handleDeleteRef(w http.ResponseWriter, req *http.Request) {
	var body deleteRefBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !repo.Exists(r.cfg.ReposBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "repo_not_found"})
		return
	}
	if _, err := runGit(req.Context(), repo.Path(r.cfg.ReposBasePath), "update-ref", "-d", body.RefName); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /internal/repos/resolve-ref?namespace=&name=&refName=
func (r *Router) handleResolveRef(w http.ResponseWriter, req *http.Request) {
	q := req.URL.Query()
	repo := Repo{Namespace: q.Get("namespace"), Name: q.Get("name")}
	if !repo.Exists(r.cfg.ReposBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "repo_not_found"})
		return
	}
	out, err := runGit(req.Context(), repo.Path(r.cfg.ReposBasePath), "rev-parse", q.Get("refName"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "ref_not_found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sha": strings.TrimSpace(out)})
}

func isZero(s string) bool {
	if s == "" {
		return true
	}
	for _, c := range s {
		if c != '0' {
			return false
		}
	}
	return true
}
