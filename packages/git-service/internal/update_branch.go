package internal

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/clawhub/git-service/internal/gitops"
)

// POST /internal/repos/update-branch
//
// Bring a Change head current with its base WITHOUT moving the base ref — the
// shard side of ChangeService.updateBranch. Returns the new head (or
// alreadyCurrent when base is already an ancestor), or 409 on a content conflict.
type updateBranchBody struct {
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	BaseBranch  string `json:"baseBranch"`
	HeadCommit  string `json:"headCommit"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
	Message     string `json:"message"`
	Method      string `json:"method"` // "merge" | "rebase"
}

func (r *Router) handleUpdateBranch(w http.ResponseWriter, req *http.Request) {
	var body updateBranchBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !validateRepo(w, repo) {
		return
	}
	method := gitops.UpdateBranchMethod(body.Method)
	if method != gitops.UpdateMerge && method != gitops.UpdateRebase {
		method = gitops.UpdateMerge
	}
	now := time.Now()
	res, err := r.ops.UpdateBranch(req.Context(), repo.Path(r.cfg.ReposBasePath), gitops.UpdateBranchParams{
		BaseBranch: body.BaseBranch,
		HeadCommit: body.HeadCommit,
		Author:     gitops.Signature{Name: body.AuthorName, Email: body.AuthorEmail, When: now},
		Committer:  gitops.Signature{Name: body.AuthorName, Email: body.AuthorEmail, When: now},
		Message:    body.Message,
		Method:     method,
	})
	if err != nil {
		var conflict *gitops.ErrUpdateConflict
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "conflict"})
			return
		}
		writeOpsErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"head": res.Head, "alreadyCurrent": res.AlreadyCurrent})
}

// POST /internal/repos/is-ancestor — the behindBase check for sharded repos.
type isAncestorBody struct {
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	Ancestor   string `json:"ancestor"`
	Descendant string `json:"descendant"`
}

func (r *Router) handleIsAncestor(w http.ResponseWriter, req *http.Request) {
	var body isAncestorBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !validateRepo(w, repo) {
		return
	}
	anc, err := r.ops.IsAncestor(req.Context(), repo.Path(r.cfg.ReposBasePath), body.Ancestor, body.Descendant)
	if err != nil {
		writeOpsErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"isAncestor": anc})
}
