package gitops

import (
	"fmt"
	"os"
)

// New picks a backend at startup. CLAWHUB_GIT_BACKEND:
//   - "libgit2" (default) — in-process via git2go. Requires libgit2 system libs.
//   - "exec"              — every op shells out to `git`.
func New() (Ops, error) {
	kind := os.Getenv("CLAWHUB_GIT_BACKEND")
	if kind == "" {
		kind = "libgit2"
	}
	switch kind {
	case "libgit2":
		return NewLibgit2Ops(), nil
	case "exec":
		return NewExecOps(), nil
	default:
		return nil, fmt.Errorf("unknown CLAWHUB_GIT_BACKEND: %q (want libgit2|exec)", kind)
	}
}
