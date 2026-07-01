// Package gitops, libgit2 backend.
//
// Linked into every binary unconditionally — git2go depends on CGo and the
// libgit2 system library, so the Dockerfile installs `libgit2`. If you need
// a pure-Go build without CGo, drop this file and remove the import from
// `ops.go`; the `Exec` backend keeps working unchanged.

package gitops

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	git "github.com/libgit2/git2go/v34"
)

// Libgit2Ops implements Ops using libgit2 via git2go. All methods open the
// repo, perform the op, and close — no handle cache yet. A future PR can add
// an LRU keyed by abs path.
type Libgit2Ops struct{}

func NewLibgit2Ops() *Libgit2Ops { return &Libgit2Ops{} }

func (*Libgit2Ops) Backend() string { return "libgit2" }

func (*Libgit2Ops) Init(_ context.Context, repoPath string) error {
	repo, err := git.InitRepository(repoPath, true)
	if err != nil {
		// Already exists — treat as success.
		if git.IsErrorCode(err, git.ErrorCodeExists) {
			r, err2 := git.OpenRepository(repoPath)
			if err2 != nil {
				return fmt.Errorf("open existing: %w", err2)
			}
			r.Free()
			return nil
		}
		return fmt.Errorf("init: %w", err)
	}
	repo.Free()
	return nil
}

func (*Libgit2Ops) ListRefs(_ context.Context, repoPath, prefix string) ([]Ref, error) {
	repo, err := git.OpenRepository(repoPath)
	if err != nil {
		return nil, &ErrNotFound{What: "repo"}
	}
	defer repo.Free()

	pattern := prefix
	if pattern == "" {
		pattern = "refs/"
	}
	if !strings.HasSuffix(pattern, "*") {
		pattern = pattern + "*"
	}
	iter, err := repo.NewReferenceIteratorGlob(pattern)
	if err != nil {
		return nil, fmt.Errorf("ref iter: %w", err)
	}
	defer iter.Free()

	var out []Ref
	for {
		ref, err := iter.Next()
		if err != nil {
			if git.IsErrorCode(err, git.ErrorCodeIterOver) {
				break
			}
			return nil, fmt.Errorf("ref next: %w", err)
		}
		// Resolve symbolic refs.
		var target *git.Reference
		if ref.Type() == git.ReferenceSymbolic {
			t, rerr := ref.Resolve()
			if rerr != nil {
				ref.Free()
				continue
			}
			target = t
		} else {
			target = ref
		}
		oid := target.Target()
		if oid == nil {
			if target != ref {
				target.Free()
			}
			ref.Free()
			continue
		}
		out = append(out, Ref{Name: ref.Name(), Sha: oid.String()})
		if target != ref {
			target.Free()
		}
		ref.Free()
	}
	return out, nil
}

func (*Libgit2Ops) ResolveRef(_ context.Context, repoPath, name string) (string, error) {
	repo, err := git.OpenRepository(repoPath)
	if err != nil {
		return "", &ErrNotFound{What: "repo"}
	}
	defer repo.Free()
	obj, err := repo.RevparseSingle(name)
	if err != nil {
		return "", &ErrNotFound{What: "ref " + name}
	}
	defer obj.Free()
	return obj.Id().String(), nil
}

func (*Libgit2Ops) UpdateRef(_ context.Context, repoPath, name, oldSha, newSha string) error {
	repo, err := git.OpenRepository(repoPath)
	if err != nil {
		return &ErrNotFound{What: "repo"}
	}
	defer repo.Free()

	newOid, err := git.NewOid(newSha)
	if err != nil {
		return fmt.Errorf("bad newSha: %w", err)
	}
	var currentValue *git.Oid
	if oldSha != "" && !isAllZero(oldSha) {
		currentValue, err = git.NewOid(oldSha)
		if err != nil {
			return fmt.Errorf("bad oldSha: %w", err)
		}
	}
	// CreateMatching CAS-updates when currentValue != nil. nil = force/create.
	ref, err := repo.References.CreateMatching(name, newOid, /*force=*/ false, currentValue, "clawhub update")
	if err != nil {
		// Detect CAS conflict by trying to read what's actually there.
		actual, _ := repo.References.Lookup(name)
		actualSha := "<none>"
		if actual != nil {
			actualSha = actual.Target().String()
			actual.Free()
		}
		if currentValue != nil && actualSha != currentValue.String() {
			return &ErrRefConflict{Ref: name, Want: oldSha, Got: actualSha}
		}
		return fmt.Errorf("update-ref: %w", err)
	}
	ref.Free()
	return nil
}

func (*Libgit2Ops) DeleteRef(_ context.Context, repoPath, name string) error {
	repo, err := git.OpenRepository(repoPath)
	if err != nil {
		return &ErrNotFound{What: "repo"}
	}
	defer repo.Free()
	ref, err := repo.References.Lookup(name)
	if err != nil {
		if git.IsErrorCode(err, git.ErrorCodeNotFound) {
			return nil
		}
		return fmt.Errorf("lookup: %w", err)
	}
	defer ref.Free()
	if err := ref.Delete(); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	return nil
}

func (*Libgit2Ops) Merge(_ context.Context, repoPath string, p MergeParams) (string, error) {
	repo, err := git.OpenRepository(repoPath)
	if err != nil {
		return "", &ErrNotFound{What: "repo"}
	}
	defer repo.Free()

	baseRefName := "refs/heads/" + p.BaseBranch
	baseRef, err := repo.References.Lookup(baseRefName)
	if err != nil {
		return "", fmt.Errorf("lookup base: %w", err)
	}
	baseSha := baseRef.Target().String()
	baseRef.Free()

	baseOid, _ := git.NewOid(baseSha)
	headOid, err := git.NewOid(p.HeadCommit)
	if err != nil {
		return "", fmt.Errorf("bad head: %w", err)
	}
	baseCommit, err := repo.LookupCommit(baseOid)
	if err != nil {
		return "", fmt.Errorf("lookup base commit: %w", err)
	}
	defer baseCommit.Free()
	headCommit, err := repo.LookupCommit(headOid)
	if err != nil {
		return "", fmt.Errorf("lookup head commit: %w", err)
	}
	defer headCommit.Free()

	author, err := git.NewSignature(p.Author.Name, p.Author.Email, p.Author.When)
	if err != nil {
		return "", fmt.Errorf("author sig: %w", err)
	}
	committer, err := git.NewSignature(p.Committer.Name, p.Committer.Email, p.Committer.When)
	if err != nil {
		return "", fmt.Errorf("committer sig: %w", err)
	}

	var newCommitOid *git.Oid
	switch p.Method {
	case MergeMerge:
		newCommitOid, err = makeMergeCommit(repo, baseCommit, headCommit, author, committer, p.Message,
			[]*git.Commit{baseCommit, headCommit})
	case MergeSquash:
		newCommitOid, err = makeMergeCommit(repo, baseCommit, headCommit, author, committer, p.Message,
			[]*git.Commit{baseCommit})
	case MergeRebase:
		newCommitOid, err = rebaseChain(repo, baseCommit, headCommit, author, committer)
	default:
		return "", fmt.Errorf("unknown method: %s", p.Method)
	}
	if err != nil {
		return "", err
	}

	// CAS-update the base branch ref.
	_, err = repo.References.CreateMatching(baseRefName, newCommitOid, /*force=*/ false, baseOid, "clawhub merge")
	if err != nil {
		return "", fmt.Errorf("update-ref base: %w", err)
	}
	return newCommitOid.String(), nil
}

func makeMergeCommit(repo *git.Repository, ours, theirs *git.Commit, author, committer *git.Signature, message string, parents []*git.Commit) (*git.Oid, error) {
	idx, err := repo.MergeCommits(ours, theirs, &git.MergeOptions{})
	if err != nil {
		return nil, fmt.Errorf("merge-commits: %w", err)
	}
	defer idx.Free()
	if idx.HasConflicts() {
		return nil, fmt.Errorf("merge has conflicts")
	}
	treeOid, err := idx.WriteTreeTo(repo)
	if err != nil {
		return nil, fmt.Errorf("write-tree: %w", err)
	}
	tree, err := repo.LookupTree(treeOid)
	if err != nil {
		return nil, fmt.Errorf("lookup-tree: %w", err)
	}
	defer tree.Free()
	return repo.CreateCommit("", author, committer, message, tree, parents...)
}

func rebaseChain(repo *git.Repository, base, head *git.Commit, author, committer *git.Signature) (*git.Oid, error) {
	// Find merge-base, replay base..head onto base.
	baseOid, err := repo.MergeBase(base.Id(), head.Id())
	if err != nil {
		return nil, fmt.Errorf("merge-base: %w", err)
	}
	// Walk from base..head in reverse order.
	walk, err := repo.Walk()
	if err != nil {
		return nil, fmt.Errorf("walk: %w", err)
	}
	defer walk.Free()
	walk.Sorting(git.SortReverse | git.SortTopological)
	if err := walk.Push(head.Id()); err != nil {
		return nil, fmt.Errorf("walk push head: %w", err)
	}
	if err := walk.Hide(baseOid); err != nil {
		return nil, fmt.Errorf("walk hide base: %w", err)
	}

	parent := base
	var newOid *git.Oid
	walkErr := walk.Iterate(func(c *git.Commit) bool {
		// Replay c onto parent.
		idx, err := repo.MergeCommits(parent, c, &git.MergeOptions{})
		if err != nil {
			newOid = nil
			return false
		}
		defer idx.Free()
		if idx.HasConflicts() {
			newOid = nil
			return false
		}
		treeOid, err := idx.WriteTreeTo(repo)
		if err != nil {
			newOid = nil
			return false
		}
		tree, err := repo.LookupTree(treeOid)
		if err != nil {
			newOid = nil
			return false
		}
		defer tree.Free()
		commitOid, err := repo.CreateCommit("", author, committer, c.Message(), tree, parent)
		if err != nil {
			newOid = nil
			return false
		}
		newParent, err := repo.LookupCommit(commitOid)
		if err != nil {
			newOid = nil
			return false
		}
		if parent != base {
			parent.Free()
		}
		parent = newParent
		newOid = commitOid
		return true
	})
	if walkErr != nil {
		return nil, fmt.Errorf("rebase walk: %w", walkErr)
	}
	if parent != base {
		defer parent.Free()
	}
	if newOid == nil {
		return nil, fmt.Errorf("rebase produced no commits")
	}
	return newOid, nil
}

func (*Libgit2Ops) IsAncestor(ctx context.Context, repoPath, ancestor, descendant string) (bool, error) {
	return isAncestorExec(ctx, repoPath, ancestor, descendant)
}

// UpdateBranch shares the git-subprocess implementation with the exec backend —
// update-branch is a cold path (not the hot merge path), so we do not duplicate
// the merge/rebase logic in git2go.
func (*Libgit2Ops) UpdateBranch(ctx context.Context, repoPath string, p UpdateBranchParams) (UpdateBranchResult, error) {
	return updateBranchExec(ctx, repoPath, p)
}

func (*Libgit2Ops) FetchPack(_ context.Context, repoPath string, wants []string, w io.Writer) error {
	repo, err := git.OpenRepository(repoPath)
	if err != nil {
		return &ErrNotFound{What: "repo"}
	}
	defer repo.Free()
	pb, err := repo.NewPackbuilder()
	if err != nil {
		return fmt.Errorf("pb: %w", err)
	}
	defer pb.Free()
	for _, sha := range wants {
		oid, err := git.NewOid(sha)
		if err != nil {
			return fmt.Errorf("bad want %s: %w", sha, err)
		}
		// InsertCommit pulls in the commit + its tree + all reachable.
		if err := pb.InsertCommit(oid); err != nil {
			// Object might not be a commit (a blob or tree was requested directly).
			if err := pb.InsertObject(oid, ""); err != nil {
				return fmt.Errorf("pb insert %s: %w", sha, err)
			}
		}
	}
	if err := pb.Write(w); err != nil {
		return fmt.Errorf("pb write: %w", err)
	}
	return nil
}

func (*Libgit2Ops) ApplyPack(_ context.Context, repoPath string, r io.Reader) error {
	repo, err := git.OpenRepository(repoPath)
	if err != nil {
		return &ErrNotFound{What: "repo"}
	}
	defer repo.Free()
	odb, err := repo.Odb()
	if err != nil {
		return fmt.Errorf("odb: %w", err)
	}
	defer odb.Free()
	indexer, err := git.NewIndexer(repoPath+"/objects/pack", odb, nil)
	if err != nil {
		return fmt.Errorf("indexer: %w", err)
	}
	defer indexer.Free()
	if _, err := io.Copy(indexer, r); err != nil {
		return fmt.Errorf("indexer write: %w", err)
	}
	if _, err := indexer.Commit(); err != nil {
		return fmt.Errorf("indexer commit: %w", err)
	}
	return nil
}

func isAllZero(s string) bool {
	for _, c := range s {
		if c != '0' {
			return false
		}
	}
	return s != ""
}

// Sanity exports to keep imports balanced if needed in future refactors.
var _ = time.Now
