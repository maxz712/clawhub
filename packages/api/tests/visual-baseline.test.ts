import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb as db, hasTestDb } from "./test-db.js";
import { repositories, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import { LocalObjectStore } from "../src/services/object-store.js";
import { createVisualBaselineRoutes } from "../src/routes/visual-baseline.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// N4 visual baseline store: PUT sets/replaces the approved PNG, GET fetches it,
// list shows metadata, DELETE removes it. Real DB (>=0053) + a disk object store.
const S = Date.now();
let routes: ReturnType<typeof createVisualBaselineRoutes>;
let token: string, ns: string, repoName: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]); // PNG magic + bytes

function req(method: string, path: string, body?: Buffer) {
  return routes.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "image/png" } : {}) },
    body,
  });
}

describe.skipIf(!hasTestDb)("N4 visual baseline store", () => {
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawhub-vb-"));
    const store = new LocalObjectStore(dir);
    routes = new Hono();
    routes.route("/", createVisualBaselineRoutes(db, store));
    routes.onError(errorHandler);
    const [u] = await db.insert(users).values({ email: `vb-${S}@t.co`, username: `vbu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
    repoName = `vbrepo${S}`;
    await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: u.id });
    token = signToken({ kind: "user", userId: u.id, email: u.email });
  });

  it("PUT sets a baseline, GET returns the bytes, list shows it", async () => {
    const put = await req("PUT", `/${ns}/${repoName}/visual-baselines/home`, PNG);
    expect(put.status).toBe(201);
    const putJson = await put.json();
    expect(putJson.key).toBe("home");
    expect(putJson.size).toBe(PNG.length);

    const get = await req("GET", `/${ns}/${repoName}/visual-baselines/home`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await get.arrayBuffer());
    expect(bytes.equals(PNG)).toBe(true);

    const list = await req("GET", `/${ns}/${repoName}/visual-baselines`);
    const listJson = await list.json();
    expect(listJson.baselines.some((b: { key: string }) => b.key === "home")).toBe(true);
  });

  it("PUT replaces an existing baseline (upsert on repo+key)", async () => {
    const png2 = Buffer.concat([PNG, Buffer.from([9, 9, 9])]);
    await req("PUT", `/${ns}/${repoName}/visual-baselines/home`, png2);
    const get = await req("GET", `/${ns}/${repoName}/visual-baselines/home`);
    const bytes = Buffer.from(await get.arrayBuffer());
    expect(bytes.equals(png2)).toBe(true);
  });

  it("rejects an empty body and a bad key", async () => {
    const empty = await req("PUT", `/${ns}/${repoName}/visual-baselines/home`, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    const bad = await req("PUT", `/${ns}/${repoName}/visual-baselines/${encodeURIComponent("bad key!!")}`, PNG);
    expect(bad.status).toBe(400);
  });

  it("DELETE removes the baseline", async () => {
    const del = await req("DELETE", `/${ns}/${repoName}/visual-baselines/home`);
    expect(del.status).toBe(200);
    const get = await req("GET", `/${ns}/${repoName}/visual-baselines/home`);
    expect(get.status).toBe(404);
  });
});
