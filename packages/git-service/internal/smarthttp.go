package internal

import (
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
)

// serveInfoRefs handles `GET /:ns/:repo.git/info/refs?service=git-{upload,receive}-pack`.
// We bypass `git http-backend` (which double-forks via CGI) and exec
// `git-{upload,receive}-pack --advertise-refs --stateless-rpc` directly. The
// output is the canonical smart-HTTP reference advertisement; we just prefix
// the magic pkt-line header before streaming.
func serveInfoRefs(w http.ResponseWriter, req *http.Request, repoDir string) {
	service := req.URL.Query().Get("service")
	if service != "git-upload-pack" && service != "git-receive-pack" {
		http.Error(w, "unknown service", http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(repoDir); err != nil {
		http.NotFound(w, req)
		return
	}

	sub := strings.TrimPrefix(service, "git-")
	w.Header().Set("Content-Type", "application/x-"+service+"-advertisement")
	w.Header().Set("Cache-Control", "no-cache")

	// Magic pkt-line preamble.
	if _, err := w.Write([]byte(packetLine("# service=" + service + "\n"))); err != nil {
		return
	}
	if _, err := w.Write([]byte("0000")); err != nil {
		return
	}

	cmd := exec.CommandContext(req.Context(), "git", sub, "--stateless-rpc", "--advertise-refs", repoDir)
	cmd.Stdout = w
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		// We've already written headers + the preamble. Best we can do is fail
		// silently — git client will report "remote hung up".
		return
	}
}

// servePackProcess handles `POST /:ns/:repo.git/git-{upload,receive}-pack`. The
// request body is the pkt-line stream the client wants to feed `git`; the
// response is whatever `git` writes back. We exec
// `git-{upload,receive}-pack --stateless-rpc REPO` and pipe.
//
// op is the subcommand name without the `git-` prefix: "upload-pack" or
// "receive-pack".
func servePackProcess(w http.ResponseWriter, req *http.Request, repoDir, op string) {
	if _, err := os.Stat(repoDir); err != nil {
		http.NotFound(w, req)
		return
	}
	w.Header().Set("Content-Type", "application/x-git-"+op+"-result")
	w.Header().Set("Cache-Control", "no-cache")

	// Optionally gunzip the request — older clients negotiate gzip on push.
	body, err := maybeDecompress(req)
	if err != nil {
		http.Error(w, "decompress: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer body.Close()

	cmd := exec.CommandContext(req.Context(), "git", op, "--stateless-rpc", repoDir)
	cmd.Stdin = body
	cmd.Stdout = flushWriter{w}
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		// As with info/refs, headers are already out. The client sees a truncated
		// response and surfaces "remote end hung up". The receive-pack
		// pre-receive hook still wrote ref_log on its way through, so the WAL
		// is correct.
		fmt.Fprintln(os.Stderr, op+": ", err)
	}
}

func maybeDecompress(req *http.Request) (io.ReadCloser, error) {
	if strings.EqualFold(req.Header.Get("Content-Encoding"), "gzip") {
		return gzip.NewReader(req.Body)
	}
	return req.Body, nil
}

// packetLine returns a pkt-line — 4-hex-digit length prefix plus payload.
// Used only for the info/refs preamble.
func packetLine(payload string) string {
	return fmt.Sprintf("%04x", len(payload)+4) + payload
}

// flushWriter writes through to the underlying ResponseWriter and flushes
// after every write. Smart HTTP sideband progress + ACKs need to reach the
// client without buffering.
type flushWriter struct{ w http.ResponseWriter }

func (fw flushWriter) Write(p []byte) (int, error) {
	n, err := fw.w.Write(p)
	if f, ok := fw.w.(http.Flusher); ok {
		f.Flush()
	}
	return n, err
}

