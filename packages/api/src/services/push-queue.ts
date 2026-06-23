import Redis from "ioredis";
import { log } from "./logger.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const STREAM_KEY = "clawhub:push:received";
const GROUP = "clawhub-post-push";

/**
 * Who performed a push. Since humans became first-class pushers, a push is
 * authored by EITHER an agent (the historical case) or a human user. Threaded
 * from the git transport through the post-push pipeline so the Change records the
 * right author and events carry the right `actorKind`.
 */
export type PushActor =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string };

export interface PushJob {
  namespace: string;
  repoName: string;
  repoId: string;
  defaultBranch: string;
  /** Who pushed. Optional in the wire format for backward-compat with jobs
   *  enqueued before humans could push — those carry only `agentId` and are read
   *  back as `{ kind: "agent", agentId }`. */
  actor?: PushActor;
  /** Legacy field: the agent that pushed. Still written for agent pushes so an
   *  older worker draining the stream keeps working; new code reads `actor`. */
  agentId?: string;
  /** Snapshot of branch heads taken before the push completed. */
  priorHeads: Record<string, string>;
  /** ISO-8601 timestamp of when this push was admitted. */
  receivedAt: string;
  /** Push-mode hint: "direct" (legacy push-to-branch) or "magic" (refs/for/...). */
  mode: "direct" | "magic";
}

/** Normalize a {@link PushJob}'s actor, tolerating the legacy `agentId`-only
 *  wire format. Returns null if neither is present (malformed job). */
export function pushJobActor(job: PushJob): PushActor | null {
  if (job.actor) return job.actor;
  if (job.agentId) return { kind: "agent", agentId: job.agentId };
  return null;
}

/**
 * Lightweight wrapper over a Redis Stream used as a durable push queue. Pushes
 * the request thread can complete the HTTP response in milliseconds; heavy
 * post-push work (trailer parse, secret scan, SAST, code-index) drains in the
 * worker fleet.
 */
export class PushQueue {
  private pub: Redis;
  private inProcessFallback: Array<(job: PushJob) => Promise<void>> = [];
  private readonly streamKey: string;

  constructor(url = REDIS_URL, streamKey = STREAM_KEY) {
    this.streamKey = streamKey;
    this.pub = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 1_500,
    });
    this.pub.on("error", () => { /* swallow so unhandled-error doesn't crash */ });
    this.pub.connect().catch(() => { /* enqueue() will fall back */ });
  }

  async enqueue(job: PushJob): Promise<void> {
    if (this.pub.status === "ready") {
      try {
        await this.pub.xadd(this.streamKey, "MAXLEN", "~", "100000", "*", "job", JSON.stringify(job));
        return;
      } catch (e) {
        log("warn", "push_queue_enqueue_failed", { err: (e as Error).message });
      }
    }
    // Redis unavailable — run synchronously via fallback handlers so we never
    // silently drop a push. This is a degraded mode; metrics should alert on it.
    for (const h of this.inProcessFallback) {
      try { await h(job); } catch (e) { log("warn", "push_fallback_handler_failed", { err: (e as Error).message }); }
    }
  }

  /** Register an in-process handler used only when Redis enqueue fails. */
  onFallback(handler: (job: PushJob) => Promise<void>): void {
    this.inProcessFallback.push(handler);
  }

  async close(): Promise<void> {
    await this.pub.quit().catch(() => undefined);
  }
}

export interface PushWorkerOptions {
  consumerName?: string;
  blockMs?: number;
  count?: number;
  /** Override the stream key — used by tests to isolate from live queues. */
  streamKey?: string;
}

/**
 * Consumer-group reader for {@link PushQueue}. Each worker process instantiates
 * one and provides a handler; the group + ack semantics make at-least-once
 * delivery safe across restarts.
 */
export class PushWorker {
  private sub: Redis;
  private running = false;
  private readonly consumer: string;
  private readonly blockMs: number;
  private readonly count: number;
  private handler: ((job: PushJob) => Promise<void>) | null = null;
  private readonly streamKey: string;

  constructor(opts: PushWorkerOptions = {}, url = REDIS_URL) {
    this.streamKey = opts.streamKey ?? STREAM_KEY;
    this.sub = new Redis(url, {
      maxRetriesPerRequest: null, // long-lived blocking XREADGROUP is the point
      enableOfflineQueue: true,
      lazyConnect: true,
      connectTimeout: 1_500,
    });
    this.sub.on("error", () => { /* swallow */ });
    this.consumer = opts.consumerName ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.blockMs = opts.blockMs ?? 5_000;
    this.count = opts.count ?? 16;
  }

  setHandler(fn: (job: PushJob) => Promise<void>): void { this.handler = fn; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.sub.connect().catch(() => {});
    try {
      await this.sub.xgroup("CREATE", this.streamKey, GROUP, "0", "MKSTREAM");
    } catch (e) {
      const msg = (e as Error).message;
      if (!/BUSYGROUP/.test(msg)) log("warn", "xgroup_create_failed", { err: msg });
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
          "COUNT", String(this.count),
          "BLOCK", String(this.blockMs),
          "STREAMS", this.streamKey, ">",
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            await this.process(id, fields);
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        log("warn", "push_worker_loop_err", { err: msg });
        if (/NOGROUP/.test(msg)) {
          // Stream or group vanished (flush, failover, ops cleanup) — recreate
          // instead of crash-looping until restart.
          try { await this.sub.xgroup("CREATE", this.streamKey, GROUP, "0", "MKSTREAM"); } catch { /* raced another worker */ }
        }
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
  }

  private async process(id: string, fields: string[]): Promise<void> {
    const idx = fields.indexOf("job");
    if (idx < 0 || !this.handler) {
      await this.ackQuiet(id);
      return;
    }
    let job: PushJob;
    try { job = JSON.parse(fields[idx + 1]) as PushJob; }
    catch { await this.ackQuiet(id); return; }

    try {
      await this.handler(job);
      await this.ackQuiet(id);
    } catch (e) {
      log("warn", "push_worker_handler_err", { err: (e as Error).message, id });
      // Leave unacked — XPENDING + retry happens on next XREADGROUP cycle for the
      // same consumer name; ops can XCLAIM to move stuck entries.
    }
  }

  private async ackQuiet(id: string): Promise<void> {
    try { await this.sub.xack(this.streamKey, GROUP, id); } catch { /* ignore */ }
  }
}
