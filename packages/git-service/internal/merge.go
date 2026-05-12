package internal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// POST /internal/repos/merge
//
// Server-side merge. The Node `ChangeService.merge` orchestrates higher-level
// state (DB updates, events) and asks the shard for the actual merge commit
// via this endpoint. Pure git plumbing, identical math to `simpleGit`.
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
	if !repo.Exists(r.cfg.ReposBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "repo_not_found"})
		return
	}
	dir := repo.Path(r.cfg.ReposBasePath)

	// Resolve the base SHA up front; all three merge methods need it.
	baseOut, err := runGit(req.Context(), dir, "rev-parse", body.BaseBranch)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "base_branch_resolve: " + err.Error()})
		return
	}
	baseSha := strings.TrimSpace(baseOut)

	env := []string{
		"GIT_AUTHOR_NAME=" + body.AuthorName,
		"GIT_AUTHOR_EMAIL=" + body.AuthorEmail,
		"GIT_COMMITTER_NAME=" + body.AuthorName,
		"GIT_COMMITTER_EMAIL=" + body.AuthorEmail,
	}

	var mergeCommit string
	switch body.Method {
	case "merge":
		mergeCommit, err = mergeRefs(req.Context(), dir, baseSha, body.HeadCommit, body.Message, env, []string{"-p", baseSha, "-p", body.HeadCommit})
	case "squash":
		mergeCommit, err = mergeRefs(req.Context(), dir, baseSha, body.HeadCommit, body.Message, env, []string{"-p", baseSha})
	case "rebase":
		mergeCommit, err = rebaseRefs(req.Context(), dir, baseSha, body.HeadCommit, env)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown_method"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	// Atomic CAS update of the base branch.
	if _, err := runGit(req.Context(), dir, "update-ref", "refs/heads/"+body.BaseBranch, mergeCommit, baseSha); err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "ref_cas_failed: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mergeCommit": mergeCommit})
}

func mergeRefs(ctx context.Context, dir, baseSha, headSha, message string, env, extraParents []string) (string, error) {
	out, err := runGitEnv(ctx, dir, env, "merge-tree", "--write-tree", baseSha, headSha)
	if err != nil {
		return "", fmt.Errorf("merge-tree: %w", err)
	}
	tree := strings.SplitN(strings.TrimSpace(out), "\n", 2)[0]
	if tree == "" {
		return "", fmt.Errorf("empty_tree")
	}
	args := append([]string{"commit-tree", tree}, extraParents...)
	args = append(args, "-m", message)
	out, err = runGitEnv(ctx, dir, env, args...)
	if err != nil {
		return "", fmt.Errorf("commit-tree: %w", err)
	}
	return strings.TrimSpace(out), nil
}

func rebaseRefs(ctx context.Context, dir, baseSha, headSha string, env []string) (string, error) {
	mb, err := runGitEnv(ctx, dir, env, "merge-base", baseSha, headSha)
	if err != nil {
		return "", fmt.Errorf("merge-base: %w", err)
	}
	mergeBase := strings.TrimSpace(mb)
	revs, err := runGitEnv(ctx, dir, env, "rev-list", "--reverse", mergeBase+".."+headSha)
	if err != nil {
		return "", fmt.Errorf("rev-list: %w", err)
	}
	parent := baseSha
	for _, sha := range strings.Split(strings.TrimSpace(revs), "\n") {
		if sha == "" {
			continue
		}
		treeOut, err := runGitEnv(ctx, dir, env, "merge-tree", "--write-tree", parent, sha)
		if err != nil {
			return "", fmt.Errorf("rebase merge-tree at %s: %w", sha, err)
		}
		tree := strings.SplitN(strings.TrimSpace(treeOut), "\n", 2)[0]
		msgOut, err := runGitEnv(ctx, dir, env, "show", "-s", "--format=%B", sha)
		if err != nil {
			return "", fmt.Errorf("show msg: %w", err)
		}
		commitOut, err := runGitEnv(ctx, dir, env, "commit-tree", tree, "-p", parent, "-m", strings.TrimSpace(msgOut))
		if err != nil {
			return "", fmt.Errorf("rebase commit-tree: %w", err)
		}
		parent = strings.TrimSpace(commitOut)
	}
	return parent, nil
}
