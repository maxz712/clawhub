import Redis from "ioredis";

const STREAM_KEY = "clawhub:events";

export interface ClawHubEvent {
  type: string;
  repoId?: string;
  changeId?: string;
  issueNumber?: number;
  actorKind?: "agent" | "human" | "system";
  actorId?: string;
  payload?: Record<string, unknown>;
}

export class EventBus {
  private pub: Redis;
  private sub: Redis;
  private subscribers = new Set<(e: ClawHubEvent) => void>();
  private started = false;

  constructor(url = process.env.REDIS_URL ?? "redis://localhost:6379") {
    this.pub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
    this.sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async publish(e: ClawHubEvent): Promise<void> {
    await this.pub.connect().catch(() => {});
    try {
      await this.pub.xadd(STREAM_KEY, "MAXLEN", "~", "10000", "*", "event", JSON.stringify(e));
    } catch {
      // Best-effort; don't fail pushes on Redis outages.
    }
    for (const s of this.subscribers) {
      try { s(e); } catch { /* ignore */ }
    }
  }

  /**
   * The last `count` retained events from the stream, oldest-first — for an SSE
   * client to replay a backlog on connect (the live subscription only delivers
   * NEW events, so without this the activity feed is empty until something
   * happens). The caller is responsible for repo-read filtering before
   * forwarding them to a subscriber.
   */
  async recentEvents(count = 50): Promise<ClawHubEvent[]> {
    try {
      await this.pub.connect().catch(() => {});
      const res = (await this.pub.xrevrange(STREAM_KEY, "+", "-", "COUNT", count)) as Array<[string, string[]]>;
      const out: ClawHubEvent[] = [];
      for (const [, fields] of res) {
        const idx = fields.indexOf("event");
        if (idx >= 0) { try { out.push(JSON.parse(fields[idx + 1]) as ClawHubEvent); } catch { /* ignore */ } }
      }
      return out.reverse(); // newest-first → oldest-first
    } catch {
      return [];
    }
  }

  onEvent(cb: (e: ClawHubEvent) => void): () => void {
    this.subscribers.add(cb);
    this.startPoll();
    return () => this.subscribers.delete(cb);
  }

  private async startPoll() {
    if (this.started) return;
    this.started = true;
    await this.sub.connect().catch(() => {});
    let lastId = "$";
    while (this.started) {
      try {
        const res = (await this.sub.xread("BLOCK", 5000, "STREAMS", STREAM_KEY, lastId)) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        for (const [, entries] of res) for (const [id, fields] of entries) {
          lastId = id;
          const idx = fields.indexOf("event");
          if (idx >= 0) {
            try {
              const parsed = JSON.parse(fields[idx + 1]) as ClawHubEvent;
              for (const s of this.subscribers) s(parsed);
            } catch { /* ignore */ }
          }
        }
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async close() {
    this.started = false;
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
