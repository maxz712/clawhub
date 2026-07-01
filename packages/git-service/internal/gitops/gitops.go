// Package gitops abstracts the git operations the shard performs.
//
// Two implementations ship in this PR:
//
//   - "libgit2": in-process via [git2go]. Used for the hot, low-latency ops
//     (refs, init, merge, pack-objects, index-pack). No fork-per-call cost.
//   - "exec":   subprocess `git` calls. Mirrors the previous behavior; kept
//     so deployments without libgit2 system libs can still run.
//
// The implementation is selected at startup via `CLAWHUB_GIT_BACKEND`
// (`libgit2` | `exec`, default `libgit2`).
//
// Smart HTTP (`info/refs`, `git-receive-pack`, `git-upload-pack`) is still
// handled by exec'ing `git-receive-pack --stateless-rpc` and
// `git-upload-pack --stateless-rpc` directly (see `internal/smarthttp.go`).
// That's the Gitaly pattern: avoid the `git http-backend` CGI fork-twice
// overhead while letting `git` itself implement the wire protocol. A
// future PR can replace the receive/upload-pack exec with a native libgit2
// wire-protocol implementation; the interface here doesn't need to change
// to land that.
//
// [git2go]: https://github.com/libgit2/git2go
package gitops

import (
	"context"
	"io"
	"time"
)

// Ref is one (refname, sha) row.
type Ref struct {
	Name string
	Sha  string
}

// Signature identifies the author/committer of a created commit.
type Signature struct {
	Name  string
	Email string
	When  time.Time
}

// MergeMethod selects the commit shape produced by Merge.
type MergeMethod string

const (
	MergeMerge  MergeMethod = "merge"
	MergeSquash MergeMethod = "squash"
	MergeRebase MergeMethod = "rebase"
)

// MergeParams describes a single server-side merge into BaseBranch.
type MergeParams struct {
	BaseBranch string
	HeadCommit string
	Author     Signature
	Committer  Signature
	Message    string
	Method     MergeMethod
}

// UpdateBranchMethod selects how UpdateBranch brings a head current with base.
type UpdateBranchMethod string

const (
	UpdateMerge  UpdateBranchMethod = "merge"  // merge commit with parents [head, base]
	UpdateRebase UpdateBranchMethod = "rebase" // replay head's own commits onto base
)

// UpdateBranchParams describes bringing HeadCommit current with BaseBranch
// WITHOUT moving BaseBranch (the reverse of MergeParams). The caller points the
// Change ref at the returned head.
type UpdateBranchParams struct {
	BaseBranch string
	HeadCommit string
	Author     Signature
	Committer  Signature
	Message    string
	Method     UpdateBranchMethod
}

// UpdateBranchResult is the outcome of UpdateBranch.
type UpdateBranchResult struct {
	Head           string // the new head (empty when AlreadyCurrent)
	AlreadyCurrent bool   // base is already an ancestor of head; nothing to do
}

// Ops is the contract every backend implements. All methods take an absolute
// repo path (bare .git directory). Errors are returned verbatim; the HTTP
// layer maps them to status codes.
type Ops interface {
	// Init creates a bare repo at repoPath. Idempotent.
	Init(ctx context.Context, repoPath string) error

	// ListRefs returns every ref whose name starts with prefix.
	ListRefs(ctx context.Context, repoPath, prefix string) ([]Ref, error)

	// ResolveRef returns the SHA the ref points at, or ("", ErrNotFound) if missing.
	ResolveRef(ctx context.Context, repoPath, name string) (string, error)

	// UpdateRef CAS-writes a ref. oldSha == "" or zeros = create-only;
	// otherwise the update is rejected if the ref's current value differs.
	UpdateRef(ctx context.Context, repoPath, name, oldSha, newSha string) error

	// DeleteRef removes a ref. Missing ref is not an error.
	DeleteRef(ctx context.Context, repoPath, name string) error

	// Merge produces a new commit per MergeParams.Method and CAS-updates
	// refs/heads/${BaseBranch} to point at it. Returns the new commit SHA.
	Merge(ctx context.Context, repoPath string, p MergeParams) (string, error)

	// UpdateBranch brings HeadCommit current with BaseBranch WITHOUT moving any
	// branch ref: a merge commit [head, base] (method "merge") or head's commits
	// replayed onto base (method "rebase"). Returns the new head, or
	// AlreadyCurrent when base is already an ancestor of head. Returns
	// *ErrUpdateConflict on a content conflict (nothing is written).
	UpdateBranch(ctx context.Context, repoPath string, p UpdateBranchParams) (UpdateBranchResult, error)

	// IsAncestor reports whether ancestor is an ancestor of descendant (or equal).
	IsAncestor(ctx context.Context, repoPath, ancestor, descendant string) (bool, error)

	// FetchPack writes a packfile containing the given commit SHAs (and their
	// reachable history) to w. Used by replication + migration to pull objects
	// from the writer shard.
	FetchPack(ctx context.Context, repoPath string, wants []string, w io.Writer) error

	// ApplyPack reads a packfile from r and installs the objects into the
	// repo's ODB. Used by the replication tailer.
	ApplyPack(ctx context.Context, repoPath string, r io.Reader) error

	// Backend identifies which implementation served the call (for metrics).
	Backend() string
}

// ErrNotFound is the sentinel for missing refs / objects.
type ErrNotFound struct{ What string }

func (e *ErrNotFound) Error() string { return e.What + " not found" }

// ErrRefConflict is returned by UpdateRef when oldSha doesn't match.
type ErrRefConflict struct{ Ref, Want, Got string }

func (e *ErrRefConflict) Error() string {
	return "ref conflict on " + e.Ref + ": want " + e.Want + ", got " + e.Got
}

// ErrUpdateConflict is returned by UpdateBranch when base and head conflict and
// the update cannot be auto-resolved.
type ErrUpdateConflict struct{}

func (*ErrUpdateConflict) Error() string { return "update-branch: content conflict" }
