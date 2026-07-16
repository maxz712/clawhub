import { describe, it, expect } from "vitest";
import { deliverMentions, notifyChangeMerged, notifyChangeRolledBack } from "../src/services/notifications.js";
import { ChangeService } from "../src/services/changes.js";
import {
  agents, changes, emailOutbox, notificationPrefs, notifications, organizations, repositories, users,
} from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";
import type { EventBus } from "../src/services/events.js";

// Batch 3 — the two highest-value collaboration signals (review-requested,
// @-mention) previously had NO sender: requestReviewers only did db.update +
// events.publish, and every mention call site discarded the resolved recipients.
// These tests prove the delivery now happens: each human recipient gets a
// durable inbox notification row AND an email queued (gated by the right pref),
// while agents and self-mentions are skipped.

interface Recorder { notifications: Record<string, unknown>[]; email_outbox: Record<string, unknown>[] }

// Recording fake DB. Returns canned rows per table (filters ignored — the test
// world holds one repo/user/prefs row) and records inserts into `rec`.
// `changeReqReviewers` seeds the change's existing requestedReviewers so the
// "don't re-notify already-requested reviewers" path can be exercised.
function makeFakeDb(
  rec: Recorder,
  changeReqReviewers?: Array<{ kind: string; id: string }>,
  prefsOverride?: Partial<Record<string, unknown>>,
): DB {
  const world: Record<string, Record<string, unknown>[]> = {
    agents: [{ id: "ag1", name: "alice" }],
    organizations: [],
    repositories: [{ id: "repo1", name: "demo", namespaceType: "agent", namespaceId: "ag1", defaultBranch: "main" }],
    changes: [{ id: "ch1", repoId: "repo1", intent: "ship the thing", status: "pending", requestedReviewers: changeReqReviewers ?? null }],
    users: [{ id: "u2", email: "bob@example.com", username: "bob" }],
    notification_prefs: [{
      id: "np1", userId: "u2", email: true,
      emailOnMention: true, emailOnReviewRequested: true, emailOnChangeMerged: true, emailOnChangeRolledBack: true, emailOnCiFailure: true,
      digestFrequency: "never",
      ...prefsOverride,
    }],
  };
  const keyOf = (t: unknown): string => {
    if (t === agents) return "agents";
    if (t === organizations) return "organizations";
    if (t === repositories) return "repositories";
    if (t === changes) return "changes";
    if (t === users) return "users";
    if (t === notificationPrefs) return "notification_prefs";
    if (t === notifications) return "notifications";
    if (t === emailOutbox) return "email_outbox";
    return "?";
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        const rows = world[keyOf(t)] ?? [];
        const chain = {
          where: (_c: unknown) => chain,
          orderBy: (_c: unknown) => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (res: (v: unknown[]) => void) => res(rows),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      },
    }),
    insert: (t: unknown) => ({
      values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(vals) ? vals : [vals];
        const key = keyOf(t);
        if (key === "notifications" || key === "email_outbox") rec[key].push(...arr);
        const p = Promise.resolve(arr) as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
        p.returning = () => Promise.resolve(arr);
        return p;
      },
    }),
    update: (_t: unknown) => ({ set: (_v: unknown) => ({ where: (_c: unknown) => Promise.resolve() }) }),
  };
  return db as unknown as DB;
}

const noopEvents = { publish: async () => {} } as unknown as EventBus;

describe("deliverMentions", () => {
  it("notifies + emails human recipients, skips agents and the author's own mention", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await deliverMentions(db, [
      { kind: "human", id: "u2", name: "bob" },
      { kind: "agent", id: "ag9", name: "botty" },
      { kind: "human", id: "u1", name: "alice" }, // the author — must be skipped
    ], {
      repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/issues/5",
      sourceKind: "issue", sourceId: "iss1", snippet: "hey @bob look at this",
      actor: { kind: "human", id: "u1" },
    });
    expect(rec.notifications.length).toBe(1);
    expect(rec.notifications[0]).toMatchObject({ userId: "u2", kind: "mention", link: "/repos/alice/demo/issues/5" });
    expect(rec.email_outbox.length).toBe(1);
    expect(rec.email_outbox[0]).toMatchObject({ toEmail: "bob@example.com" });
  });
});

describe("ChangeService.requestReviewers", () => {
  it("queues an emailOnReviewRequested email + writes a notification row for a human reviewer", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const svc = new ChangeService(makeFakeDb(rec), {} as GitService, noopEvents);
    await svc.requestReviewers("ch1", [
      { kind: "human", id: "u2" },
      { kind: "agent", id: "ag9" }, // agent reviewers are not inboxed/emailed here
    ]);
    expect(rec.notifications.length).toBe(1);
    expect(rec.notifications[0]).toMatchObject({ userId: "u2", kind: "review_requested", sourceKind: "change", sourceId: "ch1" });
    expect(rec.email_outbox.length).toBe(1);
    expect(rec.email_outbox[0]).toMatchObject({ toEmail: "bob@example.com" });
    expect(String((rec.email_outbox[0] as { subject: string }).subject)).toContain("alice/demo");
  });

  it("de-dupes a human id repeated within one call (one notification + email)", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const svc = new ChangeService(makeFakeDb(rec), {} as GitService, noopEvents);
    await svc.requestReviewers("ch1", [{ kind: "human", id: "u2" }, { kind: "human", id: "u2" }]);
    expect(rec.notifications.length).toBe(1);
    expect(rec.email_outbox.length).toBe(1);
  });

  it("does not notify the requester about their own review request", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const svc = new ChangeService(makeFakeDb(rec), {} as GitService, noopEvents);
    await svc.requestReviewers("ch1", [{ kind: "human", id: "u2" }], "u2");
    expect(rec.notifications.length).toBe(0);
    expect(rec.email_outbox.length).toBe(0);
  });

  it("does not re-notify a reviewer already in requestedReviewers (resubmit is a no-op)", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const svc = new ChangeService(makeFakeDb(rec, [{ kind: "human", id: "u2" }]), {} as GitService, noopEvents);
    await svc.requestReviewers("ch1", [{ kind: "human", id: "u2" }]);
    expect(rec.notifications.length).toBe(0);
    expect(rec.email_outbox.length).toBe(0);
  });
});

// Regression coverage for #59: the "notify on merge" pref (emailOnChangeMerged)
// + inbox kind (change_merged) were fully wired end-to-end EXCEPT the one call
// site — ChangeService.merge() never delivered anything, so the toggle at
// /notifications looked live but was a dead switch. notifyChangeMerged is the
// extracted, unit-testable delivery (merge() itself needs a real git repo +
// merge-tree, which this sandbox's git can't run, so it's exercised in
// isolation here — the same shape as deliverMentions/requestReviewers above).
describe("notifyChangeMerged", () => {
  it("notifies + emails the human who opened the change", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeMerged(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", openedByUserId: "u2", onBehalfOfUserId: null,
      by: { kind: "agent", id: "ag1" },
    });
    expect(rec.notifications.length).toBe(1);
    expect(rec.notifications[0]).toMatchObject({ userId: "u2", kind: "change_merged", sourceKind: "change", sourceId: "ch1" });
    expect(rec.email_outbox.length).toBe(1);
    expect(rec.email_outbox[0]).toMatchObject({ toEmail: "bob@example.com" });
    expect(String((rec.email_outbox[0] as { subject: string }).subject)).toContain("alice/demo");
  });

  it("falls back to onBehalfOfUserId (the sponsoring human) when an agent opened the change directly", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeMerged(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", openedByUserId: null, onBehalfOfUserId: "u2",
      by: { kind: "human", id: "u9" },
    });
    expect(rec.notifications.length).toBe(1);
    expect(rec.notifications[0]).toMatchObject({ userId: "u2", kind: "change_merged" });
    expect(rec.email_outbox.length).toBe(1);
  });

  it("does not notify a human who merges their own change", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeMerged(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", openedByUserId: "u2", onBehalfOfUserId: null,
      by: { kind: "human", id: "u2" },
    });
    expect(rec.notifications.length).toBe(0);
    expect(rec.email_outbox.length).toBe(0);
  });

  it("is a no-op when the change has neither an opener nor a sponsoring human", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeMerged(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", openedByUserId: null, onBehalfOfUserId: null,
      by: { kind: "agent", id: "ag1" },
    });
    expect(rec.notifications.length).toBe(0);
    expect(rec.email_outbox.length).toBe(0);
  });

  it("an AGENT merging does not skip notifying a human opener with the same id space (kind must match to skip)", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    // by.kind === "agent" even if by.id happens to equal the recipient user id —
    // only a HUMAN merging their own change should be skipped.
    await notifyChangeMerged(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", openedByUserId: "u2", onBehalfOfUserId: null,
      by: { kind: "agent", id: "u2" },
    });
    expect(rec.notifications.length).toBe(1);
  });
});

// Issue #70: rollback() never notified the change's opener — no inbox/email
// parity with notifyChangeMerged. notifyChangeRolledBack is the extracted,
// unit-testable delivery (rollback() itself needs a real git repo this sandbox
// can't run — same rationale as notifyChangeMerged above).
describe("notifyChangeRolledBack", () => {
  it("notifies + emails the human who opened the change, using the rollback reason as the body", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeRolledBack(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", reason: "broke prod checkout", openedByUserId: "u2", onBehalfOfUserId: null,
      by: { kind: "human", id: "u9" },
    });
    expect(rec.notifications.length).toBe(1);
    expect(rec.notifications[0]).toMatchObject({ userId: "u2", kind: "change_rolled_back", sourceKind: "change", sourceId: "ch1", body: "broke prod checkout" });
    expect(rec.email_outbox.length).toBe(1);
    expect(rec.email_outbox[0]).toMatchObject({ toEmail: "bob@example.com" });
    expect(String((rec.email_outbox[0] as { subject: string }).subject)).toContain("rolled back");
  });

  it("falls back to onBehalfOfUserId (the sponsoring human) when an agent opened the change directly", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeRolledBack(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", reason: null, openedByUserId: null, onBehalfOfUserId: "u2",
      by: { kind: "human", id: "u9" },
    });
    expect(rec.notifications.length).toBe(1);
    expect(rec.notifications[0]).toMatchObject({ userId: "u2", kind: "change_rolled_back" });
    expect(rec.email_outbox.length).toBe(1);
  });

  it("does not notify a human who rolls back their own change", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeRolledBack(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", reason: null, openedByUserId: "u2", onBehalfOfUserId: null,
      by: { kind: "human", id: "u2" },
    });
    expect(rec.notifications.length).toBe(0);
    expect(rec.email_outbox.length).toBe(0);
  });

  it("is a no-op when the change has neither an opener nor a sponsoring human", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec);
    await notifyChangeRolledBack(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", reason: null, openedByUserId: null, onBehalfOfUserId: null,
      by: { kind: "agent", id: "ag1" },
    });
    expect(rec.notifications.length).toBe(0);
    expect(rec.email_outbox.length).toBe(0);
  });

  it("respects emailOnChangeRolledBack independently of emailOnChangeMerged — still writes the inbox row but skips the email when disabled", async () => {
    const rec: Recorder = { notifications: [], email_outbox: [] };
    const db = makeFakeDb(rec, undefined, { emailOnChangeRolledBack: false });
    await notifyChangeRolledBack(db, {
      changeId: "ch1", repoId: "repo1", repoFullName: "alice/demo", link: "/repos/alice/demo/changes/ch1",
      intent: "ship the thing", reason: null, openedByUserId: "u2", onBehalfOfUserId: null,
      by: { kind: "human", id: "u9" },
    });
    expect(rec.notifications.length).toBe(1);
    expect(rec.email_outbox.length).toBe(0);
  });
});
