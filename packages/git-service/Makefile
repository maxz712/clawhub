.PHONY: proto tools build test clean

# Generate Go gRPC stubs from proto/git.proto. Requires buf
# (https://buf.build/docs/installation). Run once after editing proto/.
proto:
	buf generate

# Install local protoc plugins. Only needed if you want to bypass the buf
# remote plugins (e.g. air-gapped builds).
tools:
	go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.2
	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1

build:
	CGO_ENABLED=0 go build -o ./bin/git-service ./cmd/server

test:
	go test ./...

clean:
	rm -rf ./bin ./genproto
