// Package grpcserver wraps the same git operations the HTTP router serves,
// behind a gRPC service contract.
//
// Both transports coexist on the binary: the HTTP server keeps serving Smart
// HTTP (`info/refs`, `git-{receive,upload}-pack`) and the JSON internal API
// on `:9000`; the gRPC server listens on `:9001` for everything else.
// Picking which the Node client uses is a runtime decision via
// `CLAWHUB_TRANSPORT=grpc|http` (default `http`).
//
// Both transports share a single `gitops.Ops` instance (libgit2 by default,
// exec as the CGo-less alternative) so switching transport never changes
// semantics.
//
// The generated protobuf code lives in `genproto/git/v1/`. Run `make proto`
// (or rely on the Dockerfile's build stage) to materialize it from
// `proto/git.proto` before `go build`.
package grpcserver

import (
	"bytes"
	"context"
	"errors"
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
	"github.com/clawhub/git-service/internal/gitops"
)

// Service implements gitv1.GitServiceServer by delegating to a shared
// `gitops.Ops`. Keeping a single backend instance guarantees the two
// transports observe identical semantics.
type Service struct {
	gitv1.UnimplementedGitServiceServer
	cfg *internal.Config
	ops gitops.Ops
}

func New(cfg *internal.Config, ops gitops.Ops) *Service {
	return &Service{cfg: cfg, ops: ops}
}

// Register adds the service to a grpc.Server. The interceptor enforces the
// shared bearer token in `authorization` metadata.
func (s *Service) Register(srv *grpc.Server) {
	gitv1.RegisterGitServiceServer(srv, s)
}

// Listen starts a goroutine that serves gRPC on the given address. The
// returned *grpc.Server is the handle the caller blocks on (or stops).
func Listen(addr string, cfg *internal.Config, ops gitops.Ops) (*grpc.Server, error) {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("grpc listen %s: %w", addr, err)
	}
	srv := grpc.NewServer(
		grpc.UnaryInterceptor(unaryAuth(cfg.SharedToken)),
		grpc.StreamInterceptor(streamAuth(cfg.SharedToken)),
	)
	New(cfg, ops).Register(srv)
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
	return &gitv1.HealthResponse{Ok: true, Shard: s.cfg.ShardID, Backend: s.ops.Backend()}, nil
}

func (s *Service) Init(ctx context.Context, req *gitv1.InitRequest) (*gitv1.InitResponse, error) {
	r := internal.Repo{Namespace: req.GetRepo().GetNamespace(), Name: req.GetRepo().GetName()}
	dir := r.Path(s.cfg.ReposBasePath)
	if err := os.MkdirAll(internal.ParentDir(r, s.cfg.ReposBasePath), 0o755); err != nil {
		return nil, status.Errorf(codes.Internal, "mkdir: %v", err)
	}
	if err := s.ops.Init(ctx, dir); err != nil {
		return nil, opsErrToStatus(err)
	}
	if err := internal.InstallPreReceiveHook(dir, s.cfg); err != nil {
		return nil, status.Errorf(codes.Internal, "hook: %v", err)
	}
	return &gitv1.InitResponse{Path: dir, Backend: s.ops.Backend()}, nil
}

func (s *Service) MirrorClone(ctx context.Context, req *gitv1.MirrorCloneRequest) (*gitv1.MirrorCloneResponse, error) {
	// Mirror clone stays as a plain `git clone --bare --mirror` for now —
	// libgit2's clone w/ a mirror refspec is doable but adds CGo surface
	// for a one-time bootstrap path. The hook still goes through the
	// shared installer so a mirrored repo participates in the WAL.
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
	refs, err := s.ops.ListRefs(ctx, dir, req.GetPrefix())
	if err != nil {
		return nil, opsErrToStatus(err)
	}
	resp := &gitv1.ListRefsResponse{}
	for _, r := range refs {
		resp.Refs = append(resp.Refs, &gitv1.Ref{Name: r.Name, Sha: r.Sha})
	}
	return resp, nil
}

func (s *Service) ResolveRef(ctx context.Context, req *gitv1.ResolveRefRequest) (*gitv1.ResolveRefResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	sha, err := s.ops.ResolveRef(ctx, dir, req.GetRefName())
	if err != nil {
		return nil, opsErrToStatus(err)
	}
	return &gitv1.ResolveRefResponse{Sha: sha}, nil
}

func (s *Service) UpdateRef(ctx context.Context, req *gitv1.UpdateRefRequest) (*gitv1.UpdateRefResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	if err := s.ops.UpdateRef(ctx, dir, req.GetRefName(), req.GetOldSha(), req.GetNewSha()); err != nil {
		return nil, opsErrToStatus(err)
	}
	return &gitv1.UpdateRefResponse{}, nil
}

func (s *Service) DeleteRef(ctx context.Context, req *gitv1.DeleteRefRequest) (*gitv1.DeleteRefResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	if err := s.ops.DeleteRef(ctx, dir, req.GetRefName()); err != nil {
		return nil, opsErrToStatus(err)
	}
	return &gitv1.DeleteRefResponse{}, nil
}

func (s *Service) Merge(ctx context.Context, req *gitv1.MergeRequest) (*gitv1.MergeResponse, error) {
	dir := repoDir(s.cfg, req.GetRepo())
	if dir == "" {
		return nil, status.Error(codes.NotFound, "repo")
	}
	method := gitops.MergeMerge
	switch req.GetMethod() {
	case gitv1.MergeRequest_SQUASH:
		method = gitops.MergeSquash
	case gitv1.MergeRequest_REBASE:
		method = gitops.MergeRebase
	}
	now := time.Now()
	sha, err := s.ops.Merge(ctx, dir, gitops.MergeParams{
		BaseBranch: req.GetBaseBranch(),
		HeadCommit: req.GetHeadCommit(),
		Author:     gitops.Signature{Name: req.GetAuthorName(), Email: req.GetAuthorEmail(), When: now},
		Committer:  gitops.Signature{Name: req.GetAuthorName(), Email: req.GetAuthorEmail(), When: now},
		Message:    req.GetMessage(),
		Method:     method,
	})
	if err != nil {
		return nil, opsErrToStatus(err)
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
	// `gitops.FetchPack` writes the pack to an io.Writer. We pipe through a
	// chunking writer that sends one gRPC message per 64 KiB so we stay
	// well under the default 4 MiB max message size.
	w := &grpcChunkWriter{ss: ss, chunkSize: 64 * 1024}
	if err := s.ops.FetchPack(ss.Context(), dir, req.GetWants(), w); err != nil {
		return opsErrToStatus(err)
	}
	return w.flush()
}

func (s *Service) ApplyPack(ss gitv1.GitService_ApplyPackServer) error {
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
	// Stream the incoming chunks into a Reader that `gitops.ApplyPack` reads
	// from. Errors on the gRPC side cancel the read.
	pr, pw := io.Pipe()
	doneCh := make(chan error, 1)
	go func() { doneCh <- s.ops.ApplyPack(ss.Context(), dir, pr) }()

	var feedErr error
	for {
		msg, rerr := ss.Recv()
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			feedErr = rerr
			break
		}
		if _, werr := pw.Write(msg.GetChunk()); werr != nil {
			feedErr = werr
			break
		}
	}
	_ = pw.Close()
	applyErr := <-doneCh
	if feedErr != nil {
		return status.Errorf(codes.Internal, "recv: %v", feedErr)
	}
	if applyErr != nil {
		return opsErrToStatus(applyErr)
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

// opsErrToStatus maps `gitops` sentinel errors to gRPC status codes so the
// Node client (`services/git-grpc-client.ts`) can branch on them the same
// way the HTTP client branches on status codes.
func opsErrToStatus(err error) error {
	var notFound *gitops.ErrNotFound
	var conflict *gitops.ErrRefConflict
	switch {
	case errors.As(err, &notFound):
		return status.Error(codes.NotFound, err.Error())
	case errors.As(err, &conflict):
		return status.Error(codes.FailedPrecondition, err.Error())
	}
	return status.Errorf(codes.Internal, "%v", err)
}

// grpcChunkWriter is an io.Writer that buffers bytes and emits each `chunkSize`
// chunk as a `FetchPackResponse` message.
type grpcChunkWriter struct {
	ss        gitv1.GitService_FetchPackServer
	buf       bytes.Buffer
	chunkSize int
}

func (w *grpcChunkWriter) Write(p []byte) (int, error) {
	w.buf.Write(p)
	for w.buf.Len() >= w.chunkSize {
		chunk := make([]byte, w.chunkSize)
		_, _ = w.buf.Read(chunk)
		if err := w.ss.Send(&gitv1.FetchPackResponse{Chunk: chunk}); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func (w *grpcChunkWriter) flush() error {
	if w.buf.Len() == 0 {
		return nil
	}
	rest := make([]byte, w.buf.Len())
	_, _ = w.buf.Read(rest)
	return w.ss.Send(&gitv1.FetchPackResponse{Chunk: rest})
}
