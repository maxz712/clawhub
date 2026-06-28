package internal

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/clawhub/git-service/internal/gitops"
)

// POST /internal/repos/merge
//
// Server-side merge. The Node `ChangeService.merge` orchestrates higher-level
// state (DB updates, events) and asks the shard for the actual merge commit
// via this endpoint. The configured `gitops` backend (libgit2 by default)
// performs the merge in-process.
type mergeBody struct {
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	BaseBranch  string `json:"baseBranch"`
	HeadCommit  string `json:"headCommit"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
	Message     string `json:"message"`
	Method      string `json:"method"` // "merge" | "squash" | "rebase"
}

func (r *Router) handleMerge(w http.ResponseWriter, req *http.Request) {
	var body mergeBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	repo := Repo{Namespace: body.Namespace, Name: body.Name}
	if !validateRepo(w, repo) { // path-traversal guard
		return
	}

	method := gitops.MergeMethod(body.Method)
	if method != gitops.MergeMerge && method != gitops.MergeSquash && method != gitops.MergeRebase {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown_method"})
		return
	}

	now := time.Now()
	sha, err := r.ops.Merge(req.Context(), repo.Path(r.cfg.ReposBasePath), gitops.MergeParams{
		BaseBranch: body.BaseBranch,
		HeadCommit: body.HeadCommit,
		Author:     gitops.Signature{Name: body.AuthorName, Email: body.AuthorEmail, When: now},
		Committer:  gitops.Signature{Name: body.AuthorName, Email: body.AuthorEmail, When: now},
		Message:    body.Message,
		Method:     method,
	})
	if err != nil {
		writeOpsErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mergeCommit": sha})
}
