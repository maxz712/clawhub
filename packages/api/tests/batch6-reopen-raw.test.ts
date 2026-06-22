import { describe, it, expect } from "vitest";
import { ChangeService } from "../src/services/changes.js";
import { rawContentType } from "../src/routes/code.js";
import { changes, reviews } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";
import type { EventBus } from "../src/services/events.js";

// ── reopen (undo request-changes) ─────────────────────────────────────────────
interface Rec { updates: Array<{ table: string; vals: Record<string, unknown> }>; published: unknown[] }
function makeDb(changeRow: Record<string, unknown>, rec: Rec): DB {
  const db = {
    select: (_c?: unknown) => ({ from: (t: unknown) => {
      const rows = t === changes ? [changeRow] : [];
      const chain = { where: () => chain, limit: (n: number) => Promise.resolve(rows.slice(0, n)), then: (r: (v: unknown[]) => void) => r(rows) };
      return chain as typeof chain & PromiseLike<unknown[]>;
    } }),
    update: (t: unknown) => ({ set: (vals: Record<string, unknown>) => ({ where: () => {
      rec.updates.push({ table: t === changes ? "changes" : t === reviews ? "reviews" : "?", vals });
      return Promise.resolve();
    } }) }),
  };
  return db as unknown as DB;
}

describe("ChangeService.reopen", () => {
  it("from changes_requested: supersedes request_changes verdicts + returns to pending + publishes", async () => {
    const rec: Rec = { updates: [], published: [] };
    const events = { publish: async (e: unknown) => { rec.published.push(e); } } as unknown as EventBus;
    const svc = new ChangeService(makeDb({ id: "ch1", repoId: "r1", status: "changes_requested" }, rec), {} as GitService, events);
    await svc.reopen("ch1", { kind: "human", id: "u1" });
    expect(rec.updates.find(u => u.table === "reviews")?.vals).toHaveProperty("supersededAt");
    expect(rec.updates.find(u => u.table === "changes")?.vals).toMatchObject({ status: "pending" });
    expect(rec.published[0]).toMatchObject({ type: "change.updated", changeId: "ch1", payload: { reopened: true } });
  });

  it("rejects reopening a change that is not changes_requested", async () => {
    const rec: Rec = { updates: [], published: [] };
    const events = { publish: async () => {} } as unknown as EventBus;
    const svc = new ChangeService(makeDb({ id: "ch1", repoId: "r1", status: "pending" }, rec), {} as GitService, events);
    await expect(svc.reopen("ch1", { kind: "human", id: "u1" })).rejects.toThrow();
    expect(rec.updates).toHaveLength(0);
  });
});

// ── raw content-type (binary serve) ───────────────────────────────────────────
describe("rawContentType", () => {
  it("serves raster images INLINE", () => {
    expect(rawContentType("logo.png")).toEqual({ type: "image/png", inline: true });
    expect(rawContentType("a/b/photo.JPG")).toEqual({ type: "image/jpeg", inline: true });
    expect(rawContentType("anim.gif")).toEqual({ type: "image/gif", inline: true });
  });
  it("serves SVG as an ATTACHMENT (never inline — could carry scripts)", () => {
    expect(rawContentType("icon.svg")).toEqual({ type: "image/svg+xml", inline: false });
  });
  it("serves unknown/other types as octet-stream attachment", () => {
    expect(rawContentType("data.bin")).toEqual({ type: "application/octet-stream", inline: false });
    expect(rawContentType("report.pdf")).toEqual({ type: "application/pdf", inline: false });
    expect(rawContentType("noext")).toEqual({ type: "application/octet-stream", inline: false });
  });
});
