package internal

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/clawhub/git-service/internal/gitops"
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
	refs, err := r.ops.ListRefs(req.Context(), repo.Path(r.cfg.ReposBasePath), prefix)
	if err != nil {
		writeOpsErr(w, err)
		return
	}
	out := make([]refRow, len(refs))
	for i, x := range refs {
		out[i] = refRow{RefName: x.Name, Sha: x.Sha}
	}
	writeJSON(w, http.StatusOK, map[string]any{"refs": out})
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
	if err := r.ops.UpdateRef(req.Context(), repo.Path(r.cfg.ReposBasePath), body.RefName, body.OldSha, body.NewSha); err != nil {
		writeOpsErr(w, err)
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
	if err := r.ops.DeleteRef(req.Context(), repo.Path(r.cfg.ReposBasePath), body.RefName); err != nil {
		writeOpsErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /internal/repos/resolve-ref?namespace=&name=&refName=
func (r *Router) handleResolveRef(w http.ResponseWriter, req *http.Request) {
	q := req.URL.Query()
	repo := Repo{Namespace: q.Get("namespace"), Name: q.Get("name")}
	sha, err := r.ops.ResolveRef(req.Context(), repo.Path(r.cfg.ReposBasePath), q.Get("refName"))
	if err != nil {
		writeOpsErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sha": sha})
}

func writeOpsErr(w http.ResponseWriter, err error) {
	var notFound *gitops.ErrNotFound
	var conflict *gitops.ErrRefConflict
	switch {
	case errors.As(err, &notFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
	}
}
