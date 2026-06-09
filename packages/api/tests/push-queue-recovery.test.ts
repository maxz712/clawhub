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

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return cond();
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
      expect(await waitFor(() => seen.includes("before-delete"), 5_000)).toBe(true);

      // Simulate ops wiping the stream (group goes with it). Wait until the
      // worker has recreated the group before enqueueing — fixed sleeps flake
      // when the whole suite saturates the CPU.
      await admin.del(STREAM);
      const groupBack = async () => {
        try { return ((await admin.xinfo("GROUPS", STREAM)) as unknown[]).length > 0; }
        catch { return false; }
      };
      const deadline = Date.now() + 10_000;
      while (!(await groupBack()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
      expect(await groupBack()).toBe(true);

      await queue.enqueue(job("after-delete"));
      expect(await waitFor(() => seen.includes("after-delete"), 10_000)).toBe(true);
    } finally {
      await worker.stop();
      await queue.close();
      admin.disconnect();
    }
  }, 15_000);
});
