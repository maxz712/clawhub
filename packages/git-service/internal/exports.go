package internal

import "path/filepath"

// Exports are public wrappers reused by sibling packages
// (`internal/grpcserver`). Both transports (HTTP and gRPC) share a single
// `gitops.Ops` instance for the actual git work; the only things this file
// exposes are the small helpers that don't belong on `Ops`.

// InstallPreReceiveHook is the public counterpart of installPreReceiveHook.
// The gRPC server calls it from `Init` and `MirrorClone` so a repo created
// over gRPC behaves identically to one created over HTTP.
func InstallPreReceiveHook(repoDir string, cfg *Config) error {
	return installPreReceiveHook(repoDir, cfg)
}

// IsAllZero reports whether s is a non-empty all-zero SHA placeholder
// ("0000…0"). Used by `UpdateRef` callers to detect create-only updates.
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
// Used by `MirrorClone` to mkdir the namespace before `git clone` runs.
func ParentDir(r Repo, base string) string {
	return filepath.Join(base, r.Namespace)
}
