import { createRequire } from "node:module";
import { log } from "./logger.js";
import type { ShardEndpoint } from "./shard-map.js";

/**
 * Client for talking to a single git-service shard.
 *
 * Transport: HTTP/1.1 today. The shard's HTTP surface is enough for everything
 * the API does at request time (git Smart HTTP proxy, refs, init, merge). We
 * kept the gRPC proto (`packages/git-service/proto/git.proto`) as the target
 * surface so a future PR can drop in the codegen + Connect-RPC client behind
 * this same interface without touching callers.
 *
 * Authentication: shared bearer token from `CLAWHUB_GIT_SERVICE_TOKEN`. The
 * Node router has already verified the agent JWT before getting here; the
 * shard trusts the router.
 */

const SHARED_TOKEN = process.env.CLAWHUB_GIT_SERVICE_TOKEN ?? "";

export interface InitBareRequest {
  namespace: string;
  name: string;
}

export interface RefRow {
  refName: string;
  sha: string;
}

export interface MergeIntoRequest {
  namespace: string;
  name: string;
  baseBranch: string;
  headCommit: string;
  authorName: string;
  authorEmail: string;
  message: string;
  method: "merge" | "squash" | "rebase";
}

export interface MergeIntoResponse {
  mergeCommit: string;
}

export interface UpdateBranchIntoRequest {
  namespace: string; name: string; baseBranch: string; headCommit: string;
  authorName: string; authorEmail: string; message: string; method: "merge" | "rebase";
}

export interface UpdateBranchIntoResponse {
  head: string;
  alreadyCurrent: boolean;
}

export interface HealthResponse {
  ok: boolean;
  shard: string;
  repoCount?: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class GitClient {
  constructor(public readonly endpoint: string, private readonly token = SHARED_TOKEN) {}

  /**
   * Initialize a bare repo on this shard. Idempotent — shard returns 200 if it
   * already exists.
   */
  async initBare(req: InitBareRequest): Promise<void> {
    await this.postJson("/internal/repos/init", req);
  }

  /** List refs under a prefix. Used by the replication tailer and migration. */
  async listRefs(namespace: string, name: string, prefix = "refs/"): Promise<RefRow[]> {
    const qs = new URLSearchParams({ namespace, name, prefix });
    const j = await this.getJson<{ refs: RefRow[] }>(`/internal/repos/refs?${qs}`);
    return j.refs;
  }

  /** Atomic compare-and-swap ref update. Errors with 409 if `oldSha` doesn't match. */
  async updateRef(namespace: string, name: string, refName: string, oldSha: string, newSha: string): Promise<void> {
    await this.postJson("/internal/repos/update-ref", { namespace, name, refName, oldSha, newSha });
  }

  async deleteRef(namespace: string, name: string, refName: string): Promise<void> {
    await this.postJson("/internal/repos/delete-ref", { namespace, name, refName });
  }

  /** Resolve a ref to a SHA. */
  async resolveRef(namespace: string, name: string, refName: string): Promise<string | null> {
    try {
      const j = await this.getJson<{ sha: string }>(`/internal/repos/resolve-ref?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}&refName=${encodeURIComponent(refName)}`);
      return j.sha;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** Server-side merge. The shard performs the actual git operations; Node only orchestrates. */
  async mergeInto(req: MergeIntoRequest): Promise<MergeIntoResponse> {
    return this.postJson<MergeIntoResponse>("/internal/repos/merge", req);
  }

  /** Bring a Change head current with its base WITHOUT moving base (update-branch). Throws 409 on a content conflict. */
  async updateBranchInto(req: UpdateBranchIntoRequest): Promise<UpdateBranchIntoResponse> {
    return this.postJson<UpdateBranchIntoResponse>("/internal/repos/update-branch", req);
  }

  /** Is `ancestor` an ancestor of `descendant`? Backs behindBase for sharded repos. */
  async isAncestor(namespace: string, name: string, ancestor: string, descendant: string): Promise<boolean> {
    const j = await this.postJson<{ isAncestor: boolean }>("/internal/repos/is-ancestor", { namespace, name, ancestor, descendant });
    return j.isAncestor;
  }

  /**
   * Fetch missing objects for a set of target SHAs. Used by the replication
   * tailer to pull packs after seeing a ref_log entry whose `newSha` it
   * doesn't have locally.
   */
  async fetchPack(namespace: string, name: string, wants: string[]): Promise<Uint8Array> {
    const res = await fetch(`${this.endpoint}/internal/repos/fetch-pack`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ namespace, name, wants }),
    });
    if (!res.ok) throw new HttpError(res.status, `fetch-pack failed: ${res.status} ${await res.text()}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Apply a packfile previously produced by another shard's fetch-pack. */
  async applyPack(namespace: string, name: string, pack: Uint8Array): Promise<void> {
    const res = await fetch(`${this.endpoint}/internal/repos/apply-pack`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/octet-stream",
                 "x-clawhub-repo": `${namespace}/${name}` },
      body: pack,
    });
    if (!res.ok) throw new HttpError(res.status, `apply-pack failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Mirror clone from a different shard. The destination shard pulls from the
   * source endpoint directly using `git clone --bare` with the shared token.
   */
  async mirrorClone(req: { namespace: string; name: string; fromEndpoint: string }): Promise<void> {
    await this.postJson("/internal/repos/mirror-clone", req);
  }

  async health(): Promise<HealthResponse> {
    return this.getJson<HealthResponse>("/healthz");
  }

  /**
   * Forward a raw git Smart HTTP request body to the shard. The Hono router
   * pipes the agent's request body in and the shard's response back out
   * unmodified. Returns a `Response` so the route handler can return it as-is.
   */
  async forwardGitHttp(req: {
    namespace: string;
    name: string;
    pathSuffix: string;
    method: string;
    query: string;
    contentType?: string;
    body?: ReadableStream<Uint8Array> | null;
  }): Promise<Response> {
    const url = `${this.endpoint}/${encodeURIComponent(req.namespace)}/${encodeURIComponent(req.name)}.git/${req.pathSuffix}${req.query ? "?" + req.query : ""}`;
    const headers: Record<string, string> = { ...this.headers() };
    if (req.contentType) headers["content-type"] = req.contentType;
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers,
      body: req.body ?? undefined,
    };
    if (req.body) init.duplex = "half"; // required for streaming bodies in undici
    return fetch(url, init);
  }

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.endpoint}${path}`, { headers: this.headers() });
    if (!res.ok) throw new HttpError(res.status, `GET ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new HttpError(res.status, `POST ${path}: ${res.status} ${txt}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
}

/**
 * Pool of GitClient instances keyed by shard endpoint. Clients are cheap (they
 * hold no socket), but caching avoids re-allocating per request.
 *
 * Transport selection (`CLAWHUB_TRANSPORT`):
 *   - `http` (default) — uses {@link GitClient} for everything, including the
 *     Smart HTTP forwarding for git push/fetch.
 *   - `grpc`           — uses {@link GitGrpcClient} for the JSON RPCs. Smart
 *     HTTP forwarding still goes over HTTP (Hono pipes the body), since gRPC
 *     is a poor fit for the half-duplex pkt-line protocol.
 */
type TransportKind = "http" | "grpc";

function pickTransport(): TransportKind {
  const t = (process.env.CLAWHUB_TRANSPORT ?? "http").toLowerCase();
  return t === "grpc" ? "grpc" : "http";
}

export interface GitRpcClient {
  initBare(req: InitBareRequest): Promise<void>;
  listRefs(namespace: string, name: string, prefix?: string): Promise<RefRow[]>;
  resolveRef(namespace: string, name: string, refName: string): Promise<string | null>;
  updateRef(namespace: string, name: string, refName: string, oldSha: string, newSha: string): Promise<void>;
  deleteRef(namespace: string, name: string, refName: string): Promise<void>;
  mergeInto(req: MergeIntoRequest): Promise<MergeIntoResponse>;
  updateBranchInto(req: UpdateBranchIntoRequest): Promise<UpdateBranchIntoResponse>;
  isAncestor(namespace: string, name: string, ancestor: string, descendant: string): Promise<boolean>;
  fetchPack(namespace: string, name: string, wants: string[]): Promise<Uint8Array>;
  applyPack(namespace: string, name: string, pack: Uint8Array): Promise<void>;
  mirrorClone(req: { namespace: string; name: string; fromEndpoint: string }): Promise<void>;
  health(): Promise<HealthResponse>;
}

export class GitClientPool {
  private clients = new Map<string, GitClient>();
  private grpc = new Map<string, GitRpcClient>();
  private readonly transport: TransportKind;

  constructor(transport: TransportKind = pickTransport()) {
    this.transport = transport;
    log("info", "git_client_pool_transport", { transport });
  }

  /** Always returns an HTTP client — used for Smart HTTP forwarding. */
  get(shard: ShardEndpoint): GitClient {
    let c = this.clients.get(shard.endpoint);
    if (!c) {
      c = new GitClient(shard.endpoint);
      this.clients.set(shard.endpoint, c);
      log("info", "git_client_created", { shard: shard.id, endpoint: shard.endpoint });
    }
    return c;
  }

  /** Returns the configured RPC transport — gRPC when CLAWHUB_TRANSPORT=grpc. */
  rpc(shard: ShardEndpoint): GitRpcClient {
    if (this.transport === "http") return this.get(shard);
    let c = this.grpc.get(shard.endpoint);
    if (!c) {
      // Lazy require so HTTP-only deployments don't load @grpc/grpc-js.
      // The dynamic import returns a Promise; we wrap into a synchronous
      // facade by deferring all method calls until import resolves. For
      // simplicity we use require-style sync interop via createRequire.
      c = createGrpcClient(shard.endpoint);
      this.grpc.set(shard.endpoint, c);
    }
    return c;
  }
}

function createGrpcClient(endpoint: string): GitRpcClient {
  // Synchronous CJS require via createRequire so HTTP-only deployments don't
  // pay the cost of loading @grpc/grpc-js at module-eval time. The relative
  // path is interpreted from this file under the api package.
  const req = createRequire(import.meta.url);
  const mod = req("./git-grpc-client.js") as { GitGrpcClient: new (endpoint: string) => GitRpcClient };
  return new mod.GitGrpcClient(endpoint);
}

export { HttpError as GitClientHttpError };
