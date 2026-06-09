import { describe, it, expect } from "vitest";
import Redis from "ioredis";
import { PushQueue, PushWorker, type PushJob } from "../src/services/push-queue.js";

// Regression: PushWorker crash-looped forever with NOGROUP after the stream
// was deleted (flush, failover, ops cleanup) because the consumer group was
// only created in start(). The loop must recreate it and keep consuming.
// Skips when Redis is not reachable, like the other Redis-backed tests.

const STREAM = "clawhub:test:push-recovery";

function job(repoName: string): PushJob {
  return {
    namespace: "t", repoName, repoId: "r", defaultBranch: "main",
    agentId: "a", priorHeads: {}, receivedAt: new Date().toISOString(), mode: "direct",
  };
}

async function redisAvailable(): Promise<boolean> {
  const r = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, connectTimeout: 500, maxRetriesPerRequest: 0 });
  r.on("error", () => {});
  try { await r.connect(); await r.ping(); return true; }
  catch { return false; }
  finally { r.disconnect(); }
}

describe("PushWorker group recovery", () => {
  it("recreates the consumer group after the stream is deleted", async () => {
    if (!(await redisAvailable())) return; // environment without Redis

    const admin = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    admin.on("error", () => {});
    const seen: string[] = [];
    const worker = new PushWorker({ consumerName: "recovery-test", blockMs: 200, streamKey: STREAM });
    worker.setHandler(async j => { seen.push(j.repoName); });
    const queue = new PushQueue(undefined, STREAM);

    try {
      await worker.start();
      await queue.enqueue(job("before-delete"));
      await new Promise(r => setTimeout(r, 500));
      expect(seen).toContain("before-delete");

      // Simulate ops wiping the stream (group goes with it).
      await admin.del(STREAM);
      await new Promise(r => setTimeout(r, 1_500)); // let the loop hit NOGROUP + recover

      await queue.enqueue(job("after-delete"));
      await new Promise(r => setTimeout(r, 2_000));
      expect(seen).toContain("after-delete");
    } finally {
      await worker.stop();
      await queue.close();
      admin.disconnect();
    }
  }, 15_000);
});
