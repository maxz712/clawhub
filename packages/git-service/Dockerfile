# syntax=docker/dockerfile:1
#
# Two-stage build. The first stage installs `buf` and runs proto codegen, then
# compiles the binary. The runtime stage just needs `git` + `openssl` for the
# pre-receive hook + `curl`.
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git make
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
RUN CGO_ENABLED=0 go build -o /git-service ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache git openssl bash curl ca-certificates
COPY --from=build /git-service /usr/local/bin/git-service
EXPOSE 9000 9001
VOLUME /data/repos
ENV GIT_REPOS_BASE_PATH=/data/repos
ENTRYPOINT ["/usr/local/bin/git-service"]
