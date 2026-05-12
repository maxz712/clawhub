// Package gitops, exec backend.
//
// Identical to the pre-libgit2 behavior: every op shells out to `git`. Used
// in environments without libgit2 system libs, or as a comparison baseline.
// The wire-protocol path (receive-pack / upload-pack) still exec's `git`
// regardless of backend — see `internal/smarthttp.go`.

package gitops

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type ExecOps struct{}

func NewExecOps() *ExecOps { return &ExecOps{} }

func (*ExecOps) Backend() string { return "exec" }

func (*ExecOps) Init(ctx context.Context, repoPath string) error {
	if _, err := os.Stat(repoPath); err == nil {
		return nil
	}
	if err := os.MkdirAll(repoPath, 0o755); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, "git", "init", "--bare", repoPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("git init: %w (%s)", err, string(out))
	}
	return nil
}

func (*ExecOps) ListRefs(ctx context.Context, repoPath, prefix string) ([]Ref, error) {
	if _, err := os.Stat(repoPath); err != nil {
		return nil, &ErrNotFound{What: "repo"}
	}
	pattern := prefix
	if pattern == "" {
		pattern = "refs/"
	}
	out, err := runGit(ctx, repoPath, "for-each-ref", "--format=%(refname) %(objectname)", pattern)
	if err != nil {
		return nil, err
	}
	var refs []Ref
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		if len(parts) != 2 {
			continue
		}
		refs = append(refs, Ref{Name: parts[0], Sha: parts[1]})
	}
	return refs, nil
}

func (*ExecOps) ResolveRef(ctx context.Context, repoPath, name string) (string, error) {
	out, err := runGit(ctx, repoPath, "rev-parse", name)
	if err != nil {
		return "", &ErrNotFound{What: "ref " + name}
	}
	return strings.TrimSpace(out), nil
}

func (*ExecOps) UpdateRef(ctx context.Context, repoPath, name, oldSha, newSha string) error {
	args := []string{"update-ref", name, newSha}
	if oldSha != "" && !allZero(oldSha) {
		args = append(args, oldSha)
	}
	if _, err := runGit(ctx, repoPath, args...); err != nil {
		// Detect conflict by re-reading.
		cur, _ := runGit(ctx, repoPath, "rev-parse", name)
		cur = strings.TrimSpace(cur)
		if oldSha != "" && cur != oldSha {
			return &ErrRefConflict{Ref: name, Want: oldSha, Got: cur}
		}
		return err
	}
	return nil
}

func (*ExecOps) DeleteRef(ctx context.Context, repoPath, name string) error {
	_, err := runGit(ctx, repoPath, "update-ref", "-d", name)
	return err
}

func (*ExecOps) Merge(ctx context.Context, repoPath string, p MergeParams) (string, error) {
	baseOut, err := runGit(ctx, repoPath, "rev-parse", p.BaseBranch)
	if err != nil {
		return "", fmt.Errorf("rev-parse base: %w", err)
	}
	baseSha := strings.TrimSpace(baseOut)
	env := []string{
		"GIT_AUTHOR_NAME=" + p.Author.Name,
		"GIT_AUTHOR_EMAIL=" + p.Author.Email,
		"GIT_AUTHOR_DATE=" + p.Author.When.UTC().Format(time.RFC3339),
		"GIT_COMMITTER_NAME=" + p.Committer.Name,
		"GIT_COMMITTER_EMAIL=" + p.Committer.Email,
		"GIT_COMMITTER_DATE=" + p.Committer.When.UTC().Format(time.RFC3339),
	}

	var newSha string
	switch p.Method {
	case MergeMerge:
		newSha, err = mergeViaCommitTree(ctx, repoPath, env, baseSha, p.HeadCommit, p.Message, []string{"-p", baseSha, "-p", p.HeadCommit})
	case MergeSquash:
		newSha, err = mergeViaCommitTree(ctx, repoPath, env, baseSha, p.HeadCommit, p.Message, []string{"-p", baseSha})
	case MergeRebase:
		newSha, err = rebaseChainExec(ctx, repoPath, env, baseSha, p.HeadCommit)
	default:
		return "", fmt.Errorf("unknown method: %s", p.Method)
	}
	if err != nil {
		return "", err
	}

	if _, err := runGit(ctx, repoPath, "update-ref", "refs/heads/"+p.BaseBranch, newSha, baseSha); err != nil {
		return "", fmt.Errorf("cas update-ref: %w", err)
	}
	return newSha, nil
}

func mergeViaCommitTree(ctx context.Context, repoPath string, env []string, baseSha, headSha, message string, parents []string) (string, error) {
	treeOut, err := runGitEnv(ctx, repoPath, env, "merge-tree", "--write-tree", baseSha, headSha)
	if err != nil {
		return "", fmt.Errorf("merge-tree: %w", err)
	}
	tree := strings.SplitN(strings.TrimSpace(treeOut), "\n", 2)[0]
	if tree == "" {
		return "", fmt.Errorf("empty tree")
	}
	args := append([]string{"commit-tree", tree}, parents...)
	args = append(args, "-m", message)
	out, err := runGitEnv(ctx, repoPath, env, args...)
	if err != nil {
		return "", fmt.Errorf("commit-tree: %w", err)
	}
	return strings.TrimSpace(out), nil
}

func rebaseChainExec(ctx context.Context, repoPath string, env []string, baseSha, headSha string) (string, error) {
	mb, err := runGit(ctx, repoPath, "merge-base", baseSha, headSha)
	if err != nil {
		return "", fmt.Errorf("merge-base: %w", err)
	}
	mergeBase := strings.TrimSpace(mb)
	revs, err := runGit(ctx, repoPath, "rev-list", "--reverse", mergeBase+".."+headSha)
	if err != nil {
		return "", fmt.Errorf("rev-list: %w", err)
	}
	parent := baseSha
	for _, sha := range strings.Split(strings.TrimSpace(revs), "\n") {
		if sha == "" {
			continue
		}
		treeOut, err := runGitEnv(ctx, repoPath, env, "merge-tree", "--write-tree", parent, sha)
		if err != nil {
			return "", err
		}
		tree := strings.SplitN(strings.TrimSpace(treeOut), "\n", 2)[0]
		msgOut, err := runGitEnv(ctx, repoPath, env, "show", "-s", "--format=%B", sha)
		if err != nil {
			return "", err
		}
		commitOut, err := runGitEnv(ctx, repoPath, env, "commit-tree", tree, "-p", parent, "-m", strings.TrimSpace(msgOut))
		if err != nil {
			return "", err
		}
		parent = strings.TrimSpace(commitOut)
	}
	return parent, nil
}

func (*ExecOps) FetchPack(ctx context.Context, repoPath string, wants []string, w io.Writer) error {
	if _, err := os.Stat(repoPath); err != nil {
		return &ErrNotFound{What: "repo"}
	}
	cmd := exec.CommandContext(ctx, "git", "-C", repoPath, "pack-objects", "--stdout", "--revs", "--thin")
	cmd.Stdin = strings.NewReader(strings.Join(wants, "\n") + "\n")
	cmd.Stdout = w
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pack-objects: %w (%s)", err, stderr.String())
	}
	return nil
}

func (*ExecOps) ApplyPack(ctx context.Context, repoPath string, r io.Reader) error {
	cmd := exec.CommandContext(ctx, "git", "-C", repoPath, "index-pack", "--stdin", "--fix-thin")
	cmd.Stdin = r
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("index-pack: %w (%s)", err, stderr.String())
	}
	return nil
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	return runGitEnv(ctx, dir, nil, args...)
}

func runGitEnv(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func allZero(s string) bool {
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

// keep imports balanced
var _ = filepath.Join
