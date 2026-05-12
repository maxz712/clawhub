package internal

import (
	"bufio"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// ProxyToGitBackend invokes `git http-backend` as a CGI helper for one Smart
// HTTP request. This mirrors what the Node API does today; the seam is here
// so a future PR can replace it with go-git-based handlers.
func ProxyToGitBackend(w http.ResponseWriter, req *http.Request, repoDir, pathInfo string) {
	cmd := exec.CommandContext(req.Context(), "git", "http-backend")
	cmd.Env = append(os.Environ(),
		"GIT_PROJECT_ROOT="+repoDir,
		"GIT_HTTP_EXPORT_ALL=1",
		"PATH_INFO="+pathInfo,
		"REQUEST_METHOD="+req.Method,
		"QUERY_STRING="+req.URL.RawQuery,
		"CONTENT_TYPE="+req.Header.Get("Content-Type"),
		"CONTENT_LENGTH="+strconv.FormatInt(req.ContentLength, 10),
		"REMOTE_USER=agent",
	)
	cmd.Stdin = req.Body
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "git-backend stdout: "+err.Error(), http.StatusInternalServerError)
		return
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		http.Error(w, "git-backend start: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer cmd.Wait()

	// Parse CGI headers up to the blank line, then stream the body.
	br := bufio.NewReader(stdout)
	status := http.StatusOK
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			http.Error(w, "git-backend headers: "+err.Error(), http.StatusBadGateway)
			return
		}
		trimmed := strings.TrimRight(string(line), "\r\n")
		if trimmed == "" {
			break
		}
		idx := strings.Index(trimmed, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(trimmed[:idx])
		value := strings.TrimSpace(trimmed[idx+1:])
		if strings.EqualFold(name, "Status") {
			first := strings.SplitN(value, " ", 2)[0]
			if n, scanErr := strconv.Atoi(first); scanErr == nil {
				status = n
			}
			continue
		}
		w.Header().Add(name, value)
	}
	w.WriteHeader(status)
	if _, err := io.Copy(w, br); err != nil {
		// client probably disconnected; nothing to do
		return
	}
}
