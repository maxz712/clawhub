import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { gitShards } from "../models/schema.js";
import { GitClient } from "./git-client.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

/**
 * Per-shard health checker + circuit breaker.
 *
 *   - **Health**: poll `/healthz` every `intervalMs`. Maintain a rolling window
 *     of the last 20 results. Update `git_shards.status` in Postgres so other
 *     API instances see the same view.
 *   - **Circuit breaker**: 3 states. `closed` (normal), `open` (fail-fast),
 *     `half_open` (one probe allowed). Trips after 5 consecutive failures.
 *     Transitions to half_open after 30s. Closes after 5 consecutive successes
 *     in half_open. This is the classic Hystrix shape.
 */

export type CircuitState = "closed" | "open" | "half_open";

interface ShardState {
  endpoint: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  circuit: CircuitState;
  openedAt?: number;
  history: boolean[];
  lastPolledAt?: number;
}

export class ShardHealthMonitor {
  private states = new Map<string, ShardState>();
  private idleSkips = 0;
  private timer?: NodeJS.Timeout;
  private readonly intervalMs: number;
  private readonly failThreshold: number;
  private readonly halfOpenAfterMs: number;
  private readonly closeAfterSuccesses: number;

  constructor(
    private db: DB,
    opts: {
      intervalMs?: number;
      failThreshold?: number;
      halfOpenAfterMs?: number;
      closeAfterSuccesses?: number;
    } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.failThreshold = opts.failThreshold ?? 5;
    this.halfOpenAfterMs = opts.halfOpenAfterMs ?? 30_000;
    this.closeAfterSuccesses = opts.closeAfterSuccesses ?? 5;
  }

  start(): void {
    if (this.timer) return;
    void this.tick(); // immediate first run
    this.timer = setInterval(() => {
      // Single-node deployments have no shards: back the DB poll off to one
      // check per minute until a shard appears.
      if (this.states.size === 0 && this.idleSkips++ % 6 !== 0) return;
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getCircuit(shardId: string): CircuitState {
    return this.states.get(shardId)?.circuit ?? "closed";
  }

  /**
   * Should a caller attempt a request against this shard right now?
   *
   *   - closed → yes
   *   - open → no (caller should 503 with retry-after)
   *   - half_open → yes for *one* request; the result mutates the state
   */
  canRequest(shardId: string): boolean {
    const s = this.states.get(shardId);
    if (!s) return true;
    if (s.circuit === "closed") return true;
    if (s.circuit === "open") {
      if (s.openedAt && Date.now() - s.openedAt >= this.halfOpenAfterMs) {
        s.circuit = "half_open";
        s.consecutiveSuccesses = 0;
        log("info", "shard_circuit_half_open", { shardId });
        metrics.inc("clawhub_shard_circuit_state_change_total", { shard: shardId, to: "half_open" });
        return true;
      }
      return false;
    }
    return true; // half_open
  }

  /** Report the outcome of a real request to drive circuit state. */
  reportResult(shardId: string, success: boolean): void {
    const s = this.getOrInit(shardId);
    s.history.push(success);
    if (s.history.length > 20) s.history.shift();
    if (success) {
      s.consecutiveFailures = 0;
      s.consecutiveSuccesses += 1;
      if (s.circuit === "half_open" && s.consecutiveSuccesses >= this.closeAfterSuccesses) {
        s.circuit = "closed";
        s.openedAt = undefined;
        log("info", "shard_circuit_closed", { shardId });
        metrics.inc("clawhub_shard_circuit_state_change_total", { shard: shardId, to: "closed" });
      }
    } else {
      s.consecutiveSuccesses = 0;
      s.consecutiveFailures += 1;
      if (s.circuit !== "open" && s.consecutiveFailures >= this.failThreshold) {
        s.circuit = "open";
        s.openedAt = Date.now();
        log("warn", "shard_circuit_opened", { shardId, failures: s.consecutiveFailures });
        metrics.inc("clawhub_shard_circuit_state_change_total", { shard: shardId, to: "open" });
      }
      // In half_open, a single failure re-opens immediately.
      if (s.circuit === "half_open") {
        s.circuit = "open";
        s.openedAt = Date.now();
        log("warn", "shard_circuit_reopened", { shardId });
        metrics.inc("clawhub_shard_circuit_state_change_total", { shard: shardId, to: "open" });
      }
    }
    metrics.gauge("clawhub_shard_circuit_open", { shard: shardId }, s.circuit === "open" ? 1 : 0);
  }

  private async tick(): Promise<void> {
    let rows;
    try { rows = await this.db.select().from(gitShards); }
    catch (e) { log("warn", "shard_health_db_err", { err: (e as Error).message }); return; }

    for (const r of rows) {
      const s = this.getOrInit(r.id);
      s.endpoint = r.endpoint;
      s.lastPolledAt = Date.now();
      const client = new GitClient(r.endpoint);
      let ok = false;
      try {
        const h = await Promise.race([
          client.health(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3_000)),
        ]) as { ok: boolean };
        ok = !!h?.ok;
      } catch { ok = false; }

      this.reportResult(r.id, ok);
      const desired = ok ? "healthy" : "unhealthy";
      if (r.status !== desired) {
        try {
          await this.db.update(gitShards).set({ status: desired }).where(eq(gitShards.id, r.id));
        } catch (e) { log("warn", "shard_health_update_failed", { err: (e as Error).message, shardId: r.id }); }
      }
      metrics.gauge("clawhub_shard_health", { shard: r.id }, ok ? 1 : 0);
    }
  }

  private getOrInit(shardId: string): ShardState {
    let s = this.states.get(shardId);
    if (!s) {
      s = {
        endpoint: "",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        circuit: "closed",
        history: [],
      };
      this.states.set(shardId, s);
    }
    return s;
  }
}
