# syntax=docker/dockerfile:1
#
# Two-stage build: libgit2 + Go in the builder, libgit2 + runtime tools in the
# final image. CGo is required because git2go links against libgit2.
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git gcc musl-dev libgit2-dev pkgconfig
WORKDIR /src
COPY go.mod ./
# Pull deps before copying sources so layer cache survives source edits.
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
ENV CGO_ENABLED=1
RUN go build -tags "static,system_libgit2" -o /git-service ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache git libgit2 openssl bash curl ca-certificates
COPY --from=build /git-service /usr/local/bin/git-service
EXPOSE 9000
VOLUME /data/repos
ENV GIT_REPOS_BASE_PATH=/data/repos
ENTRYPOINT ["/usr/local/bin/git-service"]
