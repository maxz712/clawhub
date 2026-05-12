import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GitClient } from "../src/services/git-client.js";

describe("GitClient", () => {
  const origFetch = globalThis.fetch;
  let calls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/healthz") return new Response(JSON.stringify({ ok: true, shard: "shard-x" }), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/internal/repos/refs") return new Response(JSON.stringify({ refs: [{ refName: "refs/heads/main", sha: "deadbeef" }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/internal/repos/init") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/internal/repos/update-ref") return new Response(null, { status: 204 });
      if (path === "/internal/repos/merge") return new Response(JSON.stringify({ mergeCommit: "feedface" }), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/internal/repos/fetch-pack") return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200, headers: { "content-type": "application/octet-stream" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = origFetch; });

  it("attaches the bearer token if provided", async () => {
    const c = new GitClient("http://shard:9000", "tok-1");
    await c.health();
    const auth = (calls[0].init?.headers as Record<string, string> | undefined)?.["authorization"];
    expect(auth).toBe("Bearer tok-1");
  });

  it("omits the bearer header when token is empty", async () => {
    const c = new GitClient("http://shard:9000", "");
    await c.health();
    const headers = (calls[0].init?.headers as Record<string, string> | undefined) ?? {};
    expect(headers["authorization"]).toBeUndefined();
  });

  it("listRefs parses the response", async () => {
    const c = new GitClient("http://shard:9000", "t");
    const refs = await c.listRefs("acme", "core", "refs/heads/");
    expect(refs).toEqual([{ refName: "refs/heads/main", sha: "deadbeef" }]);
  });

  it("updateRef posts CAS body", async () => {
    const c = new GitClient("http://shard:9000", "t");
    await c.updateRef("acme", "core", "refs/heads/main", "0".repeat(40), "newsha");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ namespace: "acme", name: "core", refName: "refs/heads/main", oldSha: "0".repeat(40), newSha: "newsha" });
  });

  it("merge returns the new commit", async () => {
    const c = new GitClient("http://shard:9000", "t");
    const out = await c.mergeInto({
      namespace: "n", name: "r", baseBranch: "main", headCommit: "h",
      authorName: "a", authorEmail: "a@b", message: "m", method: "merge",
    });
    expect(out.mergeCommit).toBe("feedface");
  });

  it("fetchPack returns binary bytes", async () => {
    const c = new GitClient("http://shard:9000", "t");
    const bytes = await c.fetchPack("n", "r", ["abc"]);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});
