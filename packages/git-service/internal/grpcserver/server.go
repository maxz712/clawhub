// Package grpcserver wraps the same git operations the HTTP router serves,
// behind a gRPC service contract.
//
// Both transports coexist on the binary: the HTTP server keeps serving Smart
// HTTP (`info/refs`, `git-{receive,upload}-pack`) on `:9000`; the gRPC server
// listens on `:9001` for everything else. Picking which the Node client uses
// is a runtime decision via `CLAWHUB_TRANSPORT=grpc|http` (default `http`).
//
// The generated protobuf code lives in `genproto/git/v1/`. Run `make proto`
// (or rely on the Dockerfile's build stage) to materialize it from
// `proto/git.proto` before `go build`.
package grpcserver

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	gitv1 "github.com/clawhub/git-service/genproto/git/v1"
	"github.com/clawhub/git-service/internal"
)

// Service implements gitv1.GitServiceServer by delegating to the same shell
// commands the HTTP handlers use. Keeping a single execution backend
// guarantees the two transports observe identical semantics.
type Service struct {
	gitv1.UnimplementedGitServiceServer
	cfg *internal.Config
}

func New(cfg *internal.Config) *Service { return &Service{cfg: cfg} }

// Register adds the service to a grpc.Server. The interceptor enforces the
// shared bearer token in `authorization` metadata.
func (s *Service) Register(srv *grpc.Server) {
	gitv1.RegisterGitServiceServer(srv, s)
}

// Listen starts a goroutine that serves gRPC on the given address. Returns
// immediately; the caller is responsible for blocking on the http server.
func Listen(addr string, cfg *internal.Config) (*grpc.Server, error) {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("grpc listen %s: %w", addr, err)
	}
	srv := grpc.NewServer(
		grpc.UnaryInterceptor(unaryAuth(cfg.SharedToken)),
		grpc.StreamInterceptor(streamAuth(cfg.SharedToken)),
	)
	New(cfg).Register(srv)
	go func() {
		if err := srv.Serve(lis); err != nil {
			fmt.Fprintln(os.Stderr, "grpc serve:", err)
		}
	}()
	return srv, nil
}

func unaryAuth(token string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if err := checkBearer(ctx, token); err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

func streamAuth(token string) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if err := checkBearer(ss.Context(), token); err != nil {
			return err
		}
		return handler(srv, ss)
	}
}

func checkBearer(ctx context.Context, want string) error {
	if want == "" {
		return status.Error(codes.PermissionDenied, "internal_token_unset")
	}
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return status.Error(codes.Unauthenticated, "no metadata")
	}
	vs := md.Get("authorization")
	if len(vs) == 0 {
		return status.Error(codes.Unauthenticated, "no authorization header")
	}
	got := strings.TrimPrefix(vs[0], "Bearer ")
	if got != want {
		return status.Error(codes.PermissionDenied, "bad bearer")
	}
	return nil
}

// --- RPC implementations ---

func (s *Service) Health(_ context.Context, _ *gitv1.HealthRequest) (*gitv1.HealthResponse, error) {
	return &gitv1.HealthResponse{Ok: true, Shard: s.cfg.ShardID, Backend: "exec"}, nil
}

func (s *Service) Init(ctx context.Context, req *gitv1.InitRequest) (*gitv1.InitResponse, error) {
	r := internal.Repo{Namespace: req.GetRepo().GetNamespace(), Name: req.GetRepo().GetName()}
	dir := r.Path(s.cfg.ReposBasePath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, status.Errorf(codes.Internal, "mkdir: %v", err)
		}
		if out, err := exec.CommandContext(ctx, "git", "init", "--bare", dir).CombinedOutput(); err != nil {
			return nil, status.Errorf(codes.Internal, "git init: %v (%s)", err, string(out))
		}
	}
	if err := internal.InstallPreReceiveHook(dir, s.cfg); err != nil {
		return nil, status.Errorf(codes.Internal, "hook: %v", err)
	}
	return &gitv1.InitResponse{Path: dir, Backend: "exec"}, nil
}

func (s *Service) MirrorClone(ctx context.Context, req *gitv1.MirrorCloneRequest) (*gitv1.MirrorCloneResponse, error) {
	r := internal.Repo{Namespace: req.GetRepo().GetNamespace(), Name: req.GetRepo().GetName()}
	dir := r.Path(s.cfg.ReposBasePath)
	if _, err := os.Stat(dir); err == nil {
		return nil, status.Error(codes.AlreadyExists, "already exists")
	}
	if err := os.MkdirAll(internal.ParentDir(r, s.cfg.ReposBasePath), 0o755); err != nil {
		return nil, status.Errorf(codes.Internal, "mkdir: %v", err)
	}
	url := strings.TrimRight(req.GetFromEndpoint(), "/") + "/" + r.Namespace + "/" + r.Name + ".git"
	cmd := exec.CommandContext(ctx, "git", "clone", "--bare", "--mirror", url, dir)
	if s.cfg.SharedToken != "" {
		cmd.Env = append(os.Environ(),
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=http.extraheader",
			"GIT_CONFIG_VALUE_0=Authorization: Bearer "+s.cfg.SharedToken,
		)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, status.Errorf(codes.Internal, "clone: %v (%s)", err, string(out))
	}
	if err := internal.InstallPreReceiveHook(dir, s.cfg); err != nil {
		return nil, status.Errorf(codes.Internal, "hook: %v", err)
	}
	return &gitv1.MirrorCloneResponse{Path: dir}, nil
}

func (s *Service) ListRefs(ctx context.Context, req *gitv1.ListRefsRequest) (*gitv1.ListRefsResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	prefix := req.GetPrefix()
	if prefix == "" {
		prefix = "refs/"
	}
	out, err := runGit(ctx, dir, "for-each-ref", "--format=%(refname) %(objectname)", prefix)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "%v", err)
	}
	resp := &gitv1.ListRefsResponse{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		if len(parts) != 2 {
			continue
		}
		resp.Refs = append(resp.Refs, &gitv1.Ref{Name: parts[0], Sha: parts[1]})
	}
	return resp, nil
}

func (s *Service) ResolveRef(ctx context.Context, req *gitv1.ResolveRefRequest) (*gitv1.ResolveRefResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	out, err := runGit(ctx, dir, "rev-parse", req.GetRefName())
	if err != nil {
		return nil, status.Error(codes.NotFound, "ref")
	}
	return &gitv1.ResolveRefResponse{Sha: strings.TrimSpace(out)}, nil
}

func (s *Service) UpdateRef(ctx context.Context, req *gitv1.UpdateRefRequest) (*gitv1.UpdateRefResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	args := []string{"update-ref", req.GetRefName(), req.GetNewSha()}
	if old := req.GetOldSha(); old != "" && !internal.IsAllZero(old) {
		args = append(args, old)
	}
	if _, err := runGit(ctx, dir, args...); err != nil {
		if strings.Contains(err.Error(), "cannot lock ref") || strings.Contains(err.Error(), "is not a valid ref") {
			return nil, status.Errorf(codes.FailedPrecondition, "%v", err)
		}
		return nil, status.Errorf(codes.Internal, "%v", err)
	}
	return &gitv1.UpdateRefResponse{}, nil
}

func (s *Service) DeleteRef(ctx context.Context, req *gitv1.DeleteRefRequest) (*gitv1.DeleteRefResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	if _, err := runGit(ctx, dir, "update-ref", "-d", req.GetRefName()); err != nil {
		return nil, status.Errorf(codes.Internal, "%v", err)
	}
	return &gitv1.DeleteRefResponse{}, nil
}

func (s *Service) Merge(ctx context.Context, req *gitv1.MergeRequest) (*gitv1.MergeResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	method := "merge"
	switch req.GetMethod() {
	case gitv1.MergeRequest_SQUASH:
		method = "squash"
	case gitv1.MergeRequest_REBASE:
		method = "rebase"
	}
	sha, err := internal.PerformMerge(ctx, dir, internal.MergeArgs{
		BaseBranch:  req.GetBaseBranch(),
		HeadCommit:  req.GetHeadCommit(),
		AuthorName:  req.GetAuthorName(),
		AuthorEmail: req.GetAuthorEmail(),
		Message:     req.GetMessage(),
		Method:      method,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "%v", err)
	}
	return &gitv1.MergeResponse{MergeCommit: sha}, nil
}

func (s *Service) FetchPack(req *gitv1.FetchPackRequest, ss gitv1.GitService_FetchPackServer) error {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return status.Error(codes.NotFound, "repo")
	}
	if len(req.GetWants()) == 0 {
		return status.Error(codes.InvalidArgument, "no wants")
	}
	cmd := exec.CommandContext(ss.Context(), "git", "-C", dir, "pack-objects", "--stdout", "--revs", "--thin")
	cmd.Stdin = strings.NewReader(strings.Join(req.GetWants(), "\n") + "\n")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return status.Errorf(codes.Internal, "stdout: %v", err)
	}
	if err := cmd.Start(); err != nil {
		return status.Errorf(codes.Internal, "start: %v", err)
	}
	buf := make([]byte, 64*1024)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			if sendErr := ss.Send(&gitv1.FetchPackResponse{Chunk: buf[:n]}); sendErr != nil {
				_ = cmd.Process.Kill()
				return sendErr
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = cmd.Process.Kill()
			return status.Errorf(codes.Internal, "read: %v", err)
		}
	}
	if err := cmd.Wait(); err != nil {
		return status.Errorf(codes.Internal, "wait: %v", err)
	}
	return nil
}

func (s *Service) ApplyPack(ss gitv1.GitService_ApplyPackServer) error {
	// First message must carry repo; subsequent messages carry pack chunks.
	first, err := ss.Recv()
	if err != nil {
		return err
	}
	r := first.GetRepo()
	if r == nil {
		return status.Error(codes.InvalidArgument, "first message must carry repo")
	}
	dir := repoDir(s.cfg, r)
	if dir == "" {
		return status.Error(codes.NotFound, "repo")
	}
	cmd := exec.CommandContext(ss.Context(), "git", "-C", dir, "index-pack", "--stdin", "--fix-thin")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return status.Errorf(codes.Internal, "stdin: %v", err)
	}
	if err := cmd.Start(); err != nil {
		return status.Errorf(codes.Internal, "start: %v", err)
	}
	for {
		msg, err := ss.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = stdin.Close()
			_ = cmd.Process.Kill()
			return err
		}
		if _, werr := stdin.Write(msg.GetChunk()); werr != nil {
			_ = cmd.Process.Kill()
			return status.Errorf(codes.Internal, "write: %v", werr)
		}
	}
	_ = stdin.Close()
	if err := cmd.Wait(); err != nil {
		return status.Errorf(codes.Internal, "index-pack: %v", err)
	}
	return ss.SendAndClose(&gitv1.ApplyPackResponse{})
}

// --- helpers ---

func repoDir(cfg *internal.Config, r *gitv1.Repo) string {
	if r == nil {
		return ""
	}
	rr := internal.Repo{Namespace: r.GetNamespace(), Name: r.GetName()}
	if !rr.Exists(cfg.ReposBasePath) {
		return ""
	}
	return rr.Path(cfg.ReposBasePath)
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
