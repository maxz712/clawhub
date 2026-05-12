package internal

import (
	"os"
	"path/filepath"
)

type Repo struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

func (r Repo) Path(base string) string {
	return filepath.Join(base, r.Namespace, r.Name+".git")
}

func (r Repo) Exists(base string) bool {
	info, err := os.Stat(r.Path(base))
	return err == nil && info.IsDir()
}
