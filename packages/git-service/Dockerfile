FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN go build -o /git-service ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache git openssl bash curl ca-certificates
COPY --from=build /git-service /usr/local/bin/git-service
EXPOSE 9000
VOLUME /data/repos
ENV GIT_REPOS_BASE_PATH=/data/repos
ENTRYPOINT ["/usr/local/bin/git-service"]
