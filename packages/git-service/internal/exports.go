package internal

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// Exports are public wrappers reused by sibling packages
// (`internal/grpcserver`). Keeping them here avoids changing the existing
// HTTP handler function names while still giving the gRPC server one
// authoritative path for merge / hook-install logic.

// InstallPreReceiveHook is the public counterpart of installPreReceiveHook.
func InstallPreReceiveHook(repoDir string, cfg *Config) error {
	return installPreReceiveHook(repoDir, cfg)
}

// IsAllZero reports whether s is a non-empty all-zero SHA placeholder
// ("0000…0"). Both the HTTP and gRPC update-ref handlers consult this.
func IsAllZero(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c != '0' {
			return false
		}
	}
	return true
}

// ParentDir returns the namespace directory for a repo (parent of `.git`).
func ParentDir(r Repo, base string) string {
	return filepath.Join(base, r.Namespace)
}

// MergeArgs captures the inputs of a server-side merge. Mirrors the JSON
// `mergeBody` used by the HTTP handler.
type MergeArgs struct {
	BaseBranch  string
	HeadCommit  string
	AuthorName  string
	AuthorEmail string
	Message     string
	Method      string // "merge" | "squash" | "rebase"
}

// PerformMerge runs the same merge/squash/rebase math as the HTTP handler,
// CAS-updates the base ref, and returns the new commit SHA. Shared by both
// transports.
func PerformMerge(ctx context.Context, dir string, p MergeArgs) (string, error) {
	baseOut, err := runGit(ctx, dir, "rev-parse", p.BaseBranch)
	if err != nil {
		return "", fmt.Errorf("rev-parse base: %w", err)
	}
	baseSha := strings.TrimSpace(baseOut)

	env := []string{
		"GIT_AUTHOR_NAME=" + p.AuthorName,
		"GIT_AUTHOR_EMAIL=" + p.AuthorEmail,
		"GIT_COMMITTER_NAME=" + p.AuthorName,
		"GIT_COMMITTER_EMAIL=" + p.AuthorEmail,
	}

	var newSha string
	switch p.Method {
	case "merge":
		newSha, err = mergeRefs(ctx, dir, baseSha, p.HeadCommit, p.Message, env, []string{"-p", baseSha, "-p", p.HeadCommit})
	case "squash":
		newSha, err = mergeRefs(ctx, dir, baseSha, p.HeadCommit, p.Message, env, []string{"-p", baseSha})
	case "rebase":
		newSha, err = rebaseRefs(ctx, dir, baseSha, p.HeadCommit, env)
	default:
		return "", fmt.Errorf("unknown method: %s", p.Method)
	}
	if err != nil {
		return "", err
	}
	if _, err := runGit(ctx, dir, "update-ref", "refs/heads/"+p.BaseBranch, newSha, baseSha); err != nil {
		return "", fmt.Errorf("cas update-ref: %w", err)
	}
	return newSha, nil
}
