import { fileURLToPath } from "node:url";
import path from "node:path";
import { credentials, Metadata, type ServiceError } from "@grpc/grpc-js";
import { loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { log } from "./logger.js";
import type { InitBareRequest, MergeIntoRequest, MergeIntoResponse, UpdateBranchIntoRequest, UpdateBranchIntoResponse, RefRow, HealthResponse } from "./git-client.js";

/**
 * gRPC implementation of the {@link GitRpc} surface used by the Node router.
 *
 *   - Loads `proto/git.proto` at startup via `@grpc/proto-loader` (no codegen
 *     step). The proto file is bundled with the api package at
 *     `packages/api/proto/git.proto`.
 *   - Wraps the generated client into the same method shapes the HTTP client
 *     exposes — callers don't notice the transport switch.
 *   - Smart-HTTP `forwardGitHttp` is intentionally *not* offered here: pushing
 *     a half-duplex pkt-line stream through gRPC is awkward, and the HTTP
 *     transport is fine for it. The factory keeps both available.
 *
 * Transport selection: `CLAWHUB_TRANSPORT=grpc|http` (default `http`).
 */

function sharedToken(): string {
  // Read per-call so tests that set the env var in a beforeAll() hook still work.
  return process.env.CLAWHUB_GIT_SERVICE_TOKEN ?? "";
}

interface ClientWritable {
  write(msg: unknown): boolean;
  end(): void;
}

interface ClientReadable {
  on(event: "data", listener: (msg: { chunk: Buffer }) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

interface GitServiceClient {
  Init(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  MirrorClone(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  ListRefs(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  ResolveRef(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  UpdateRef(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  DeleteRef(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  Merge(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  Health(req: unknown, metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): void;
  FetchPack(req: unknown, metadata: Metadata): ClientReadable;
  ApplyPack(metadata: Metadata, cb: (err: ServiceError | null, res: unknown) => void): ClientWritable;
  close(): void;
}

interface PackageRoot {
  clawhub: {
    git: {
      v1: {
        GitService: new (target: string, creds: ReturnType<typeof credentials.createInsecure>) => GitServiceClient;
      };
    };
  };
}

const PROTO_PATH = resolveProtoPath();

function resolveProtoPath(): string {
  // ESM-friendly resolution: walk up from this file to find /proto/git.proto.
  // In dev (tsx), __dirname doesn't exist; use import.meta.url.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/api/src/services -> packages/api/proto
  return path.resolve(here, "..", "..", "proto", "git.proto");
}

let packageDef: PackageRoot | null = null;
function getPackageDef(): PackageRoot {
  if (packageDef) return packageDef;
  const def = loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  packageDef = loadPackageDefinition(def) as unknown as PackageRoot;
  return packageDef;
}

function endpointToTarget(endpoint: string): string {
  // gRPC's createInsecure expects "host:port". The endpoint we store is an
  // HTTP URL ("http://shard:9000"); rewrite to the gRPC port (9001 by default
  // in the Helm chart) or honor an explicit `?grpc_port=` query.
  const u = new URL(endpoint);
  const grpcPort = u.searchParams.get("grpc_port") ?? process.env.CLAWHUB_DEFAULT_GRPC_PORT ?? "9001";
  return `${u.hostname}:${grpcPort}`;
}

function authMetadata(): Metadata {
  const md = new Metadata();
  const tok = sharedToken();
  if (tok) md.set("authorization", `Bearer ${tok}`);
  return md;
}

function call<T>(invoke: (cb: (err: ServiceError | null, res: unknown) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((err, res) => (err ? reject(err) : resolve(res as T)));
  });
}

export class GitGrpcClient {
  private client: GitServiceClient;

  constructor(public readonly endpoint: string) {
    const pkg = getPackageDef();
    this.client = new pkg.clawhub.git.v1.GitService(endpointToTarget(endpoint), credentials.createInsecure());
    log("info", "git_grpc_client_created", { endpoint });
  }

  async initBare(req: InitBareRequest): Promise<void> {
    await call(cb => this.client.Init({ repo: { namespace: req.namespace, name: req.name } }, authMetadata(), cb));
  }

  async listRefs(namespace: string, name: string, prefix = "refs/"): Promise<RefRow[]> {
    const res = await call<{ refs?: Array<{ name: string; sha: string }> }>(cb =>
      this.client.ListRefs({ repo: { namespace, name }, prefix }, authMetadata(), cb));
    return (res.refs ?? []).map(r => ({ refName: r.name, sha: r.sha }));
  }

  async resolveRef(namespace: string, name: string, refName: string): Promise<string | null> {
    try {
      const res = await call<{ sha: string }>(cb =>
        this.client.ResolveRef({ repo: { namespace, name }, refName }, authMetadata(), cb));
      return res.sha;
    } catch (e) {
      if ((e as ServiceError).code === 5 /* NOT_FOUND */) return null;
      throw e;
    }
  }

  async updateRef(namespace: string, name: string, refName: string, oldSha: string, newSha: string): Promise<void> {
    await call(cb => this.client.UpdateRef({
      repo: { namespace, name }, refName, oldSha, newSha,
    }, authMetadata(), cb));
  }

  async deleteRef(namespace: string, name: string, refName: string): Promise<void> {
    await call(cb => this.client.DeleteRef({ repo: { namespace, name }, refName }, authMetadata(), cb));
  }

  async mergeInto(req: MergeIntoRequest): Promise<MergeIntoResponse> {
    const methodEnum = req.method === "merge" ? "MERGE" : req.method === "squash" ? "SQUASH" : "REBASE";
    const res = await call<{ mergeCommit: string }>(cb => this.client.Merge({
      repo: { namespace: req.namespace, name: req.name },
      baseBranch: req.baseBranch,
      headCommit: req.headCommit,
      authorName: req.authorName,
      authorEmail: req.authorEmail,
      message: req.message,
      method: methodEnum,
    }, authMetadata(), cb));
    return { mergeCommit: res.mergeCommit };
  }

  // update-branch / is-ancestor are served only over the HTTP transport for now
  // (they'd need new gRPC methods + regenerated protobuf). The default transport
  // is HTTP, so sharded update-branch works there; explicit grpc callers get a
  // clear error rather than a silent wrong result.
  async updateBranchInto(_req: UpdateBranchIntoRequest): Promise<UpdateBranchIntoResponse> {
    throw new Error("update-branch is not supported over the grpc transport — set CLAWHUB_TRANSPORT=http");
  }

  async isAncestor(_namespace: string, _name: string, _ancestor: string, _descendant: string): Promise<boolean> {
    throw new Error("is-ancestor is not supported over the grpc transport — set CLAWHUB_TRANSPORT=http");
  }

  async fetchPack(namespace: string, name: string, wants: string[]): Promise<Uint8Array> {
    const stream = this.client.FetchPack({ repo: { namespace, name }, wants }, authMetadata());
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (msg: { chunk: Buffer }) => chunks.push(msg.chunk));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return new Uint8Array(Buffer.concat(chunks));
  }

  async applyPack(namespace: string, name: string, pack: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = this.client.ApplyPack(authMetadata(), err => err ? reject(err) : resolve());
      stream.write({ repo: { namespace, name } });
      // Chunk the pack so gRPC stays under the default 4MB message limit.
      const chunkSize = 1024 * 1024;
      for (let i = 0; i < pack.length; i += chunkSize) {
        stream.write({ chunk: pack.subarray(i, Math.min(i + chunkSize, pack.length)) });
      }
      stream.end();
    });
  }

  async mirrorClone(req: { namespace: string; name: string; fromEndpoint: string }): Promise<void> {
    await call(cb => this.client.MirrorClone({
      repo: { namespace: req.namespace, name: req.name },
      fromEndpoint: req.fromEndpoint,
    }, authMetadata(), cb));
  }

  async health(): Promise<HealthResponse> {
    const res = await call<{ ok: boolean; shard: string }>(cb => this.client.Health({}, authMetadata(), cb));
    return { ok: res.ok, shard: res.shard };
  }

  close(): void {
    this.client.close();
  }
}
