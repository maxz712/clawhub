package internal

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Repo struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// ErrUnsafePath is returned when a Namespace/Name fails the path-segment guard.
// Path construction is fail-closed: callers must reject this rather than touch
// disk. Mirrors `isSafePathSegment` in packages/api/src/services/namespace.ts.
var ErrUnsafePath = errors.New("unsafe_path_segment")

// safeSegment accepts a single path segment that is safe to join under the repo
// base: a leading alphanumeric, then alphanumerics / dot / underscore / dash.
// No `/`, `\`, NUL, `.`, `..`, or empty — those could traverse out of the base
// or be parsed as a git option.
var safeSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

// isSafePathSegment reports whether s is a safe on-disk path segment. Fail-closed:
// rejects empty, ".", "..", anything containing "..", "/", "\\", or NUL.
func isSafePathSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, "/\\\x00") || strings.Contains(s, "..") {
		return false
	}
	return safeSegment.MatchString(s)
}

// Validate rejects any caller-supplied Namespace/Name that could escape the repo
// base directory. Call it before building a path from caller input.
func (r Repo) Validate() error {
	if !isSafePathSegment(r.Namespace) || !isSafePathSegment(r.Name) {
		return ErrUnsafePath
	}
	return nil
}

func (r Repo) Path(base string) string {
	return filepath.Join(base, r.Namespace, r.Name+".git")
}

func (r Repo) Exists(base string) bool {
	// Fail-closed: an unsafe segment can never reference an existing repo.
	if r.Validate() != nil {
		return false
	}
	info, err := os.Stat(r.Path(base))
	return err == nil && info.IsDir()
}
