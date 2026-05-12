import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Server, ServerCredentials, credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GitGrpcClient } from "../src/services/git-grpc-client.js";

// Light end-to-end test: stand up a real grpc-js server with hand-coded
// handlers that return canned responses, then drive it via GitGrpcClient.
// Confirms (a) the proto loads, (b) the client/server message shapes line
// up, and (c) bearer-auth metadata is wired correctly.

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "proto", "git.proto");

describe("GitGrpcClient end-to-end", () => {
  let server: Server;
  let port = 0;
  const TOKEN = "test-shared-token";
  const RECEIVED_BEARERS: string[] = [];

  beforeAll(async () => {
    process.env.CLAWHUB_GIT_SERVICE_TOKEN = TOKEN;
    const def = loadSync(PROTO, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
    const pkg = loadPackageDefinition(def) as any;
    server = new Server();
    server.addService(pkg.clawhub.git.v1.GitService.service, {
      Health: (call: any, cb: any) => {
        RECEIVED_BEARERS.push((call.metadata.get("authorization")?.[0] as string) ?? "");
        cb(null, { ok: true, shard: "shard-test", backend: "exec" });
      },
      ListRefs: (call: any, cb: any) => {
        cb(null, { refs: [{ name: "refs/heads/main", sha: "deadbeef" }] });
      },
      Init: (_call: any, cb: any) => cb(null, { path: "/data/x.git", backend: "exec" }),
      UpdateRef: (_call: any, cb: any) => cb(null, {}),
      Merge: (call: any, cb: any) => cb(null, { mergeCommit: "cafef00d" }),
    });
    port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, p) => err ? reject(err) : resolve(p));
    });
    server.start();
    process.env.CLAWHUB_DEFAULT_GRPC_PORT = String(port);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.tryShutdown(() => resolve()));
  });

  function client() {
    return new GitGrpcClient(`http://127.0.0.1:${port}`);
  }

  it("passes the shared bearer token in metadata", async () => {
    await client().health();
    expect(RECEIVED_BEARERS.at(-1)).toBe(`Bearer ${TOKEN}`);
  });

  it("listRefs maps the response", async () => {
    const refs = await client().listRefs("ns", "r", "refs/heads/");
    expect(refs).toEqual([{ refName: "refs/heads/main", sha: "deadbeef" }]);
  });

  it("mergeInto returns the new commit", async () => {
    const out = await client().mergeInto({
      namespace: "n", name: "r", baseBranch: "main", headCommit: "abc",
      authorName: "a", authorEmail: "a@b", message: "m", method: "squash",
    });
    expect(out.mergeCommit).toBe("cafef00d");
  });

  it("initBare succeeds", async () => {
    await expect(client().initBare({ namespace: "ns", name: "r" })).resolves.toBeUndefined();
  });

  it("updateRef succeeds", async () => {
    await expect(client().updateRef("ns", "r", "refs/heads/main", "0".repeat(40), "newsha")).resolves.toBeUndefined();
  });
});
