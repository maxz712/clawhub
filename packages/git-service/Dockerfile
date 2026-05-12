# syntax=docker/dockerfile:1
#
# Two-stage build:
#   1. Build stage: libgit2 system libs + buf for proto codegen + Go toolchain.
#      Generates the gRPC stubs from proto/git.proto, then compiles a binary
#      linked against libgit2 (CGo on, `static,system_libgit2` build tags).
#   2. Runtime stage: thin alpine with libgit2 + git + openssl + curl. The
#      pre-receive hook uses openssl for HMAC; curl posts the WAL writes.
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git make gcc musl-dev libgit2-dev pkgconfig
# Install buf for proto codegen. Pinned for reproducibility.
ARG BUF_VERSION=1.45.0
RUN wget -qO /usr/local/bin/buf "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-x86_64" \
 && chmod +x /usr/local/bin/buf
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY proto/ ./proto/
COPY buf.yaml buf.gen.yaml Makefile ./
RUN buf generate
COPY cmd/ ./cmd/
COPY internal/ ./internal/
ENV CGO_ENABLED=1
RUN go build -tags "static,system_libgit2" -o /git-service ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache git libgit2 openssl bash curl ca-certificates
COPY --from=build /git-service /usr/local/bin/git-service
EXPOSE 9000 9001
VOLUME /data/repos
ENV GIT_REPOS_BASE_PATH=/data/repos
ENTRYPOINT ["/usr/local/bin/git-service"]
