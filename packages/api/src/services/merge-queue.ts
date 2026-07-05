import Redis from "ioredis";
import { log } from "./logger.js";
import { withRepoLock } from "./repo-lock.js";
import type { ChangeService, MergeMethod } from "./changes.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const STREAM_KEY = "clawhub:merge:queued";
const GROUP = "clawhub-merge";

export interface MergeJob {
  changeId: string;
  repoId: string;
  by: { kind: "agent" | "human"; id: string };
  method?: MergeMethod;
  /** Optional idempotency key — same key skipped if already merged. */
  requestId?: string;
  /**
   * Head the merge was authorized against. A deferred/auto-merge job re-asserts this
   * equals the change's LIVE head under the repo lock before merging — so a push that
   * lands a new diff between enqueue and execution can never merge the un-approved
   * head. Absent = no head pin (a synchronous human click merges whatever is live).
   */
  expectHead?: string;
}

/**
 * Server-side merge queue. The merge endpoint enqueues a {@link MergeJob}, and
 * a worker drains the queue with per-repo serialization via {@link withRepoLock}.
 * This pairs with the ref-per-change push model: agents don't race on
 * refs/heads/main; the merge step is the single writer.
 */
export class MergeQueue {
  private pub: Redis;

  constructor(url = REDIS_URL) {
    this.pub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async enqueue(job: MergeJob): Promise<void> {
    try {
      await this.pub.connect().catch(() => {});
      await this.pub.xadd(STREAM_KEY, "MAXLEN", "~", "20000", "*", "job", JSON.stringify(job));
    } catch (e) {
      log("warn", "merge_enqueue_failed", { err: (e as Error).message });
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.pub.quit().catch(() => undefined);
  }
}

export interface MergeWorkerDeps {
  changes: ChangeService;
}

export class MergeWorker {
  private sub: Redis;
  private running = false;
  private readonly consumer = `merge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(private deps: MergeWorkerDeps, url = REDIS_URL) {
    this.sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.sub.connect().catch(() => {});
    try {
      await this.sub.xgroup("CREATE", STREAM_KEY, GROUP, "0", "MKSTREAM");
    } catch (e) {
      const msg = (e as Error).message;
      if (!/BUSYGROUP/.test(msg)) log("warn", "merge_xgroup_create_failed", { err: msg });
    }
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.sub.quit().catch(() => undefined);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const res = (await this.sub.xreadgroup(
          "GROUP", GROUP, this.consumer,
          "COUNT", "4", "BLOCK", "5000",
          "STREAMS", STREAM_KEY, ">",
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            await this.processOne(id, fields);
          }
        }
      } catch (e) {
        log("warn", "merge_worker_loop_err", { err: (e as Error).message });
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
  }

  private async processOne(id: string, fields: string[]): Promise<void> {
    const idx = fields.indexOf("job");
    if (idx < 0) { await this.ack(id); return; }
    let job: MergeJob;
    try { job = JSON.parse(fields[idx + 1]) as MergeJob; }
    catch { await this.ack(id); return; }

    try {
      await withRepoLock(job.repoId, async () => {
        await this.deps.changes.merge(job.changeId, job.by, job.method ?? "merge", { expectHead: job.expectHead });
      }, { kind: "merge-queue", ttlMs: 120_000, waitMs: 30_000 });
      await this.ack(id);
    } catch (e) {
      log("warn", "merge_job_failed", { err: (e as Error).message, changeId: job.changeId });
      // Leave unacked so XPENDING can surface it. Operationally, alerts on
      // pending entries point at stuck merges.
    }
  }

  private async ack(id: string): Promise<void> {
    try { await this.sub.xack(STREAM_KEY, GROUP, id); } catch { /* ignore */ }
  }
}
