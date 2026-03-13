import Redis from "ioredis";

export interface ClawForgeEvent {
  type: string;
  repoId?: string;
  agentId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export class EventBus {
  private redis: Redis | null = null;
  private streamKey = "clawforge:events";

  constructor(redisUrl?: string) {
    const url = redisUrl ?? process.env.REDIS_URL;
    if (url) {
      try {
        this.redis = new Redis(url, {
          maxRetriesPerRequest: 3,
          lazyConnect: true,
        });
        this.redis.connect().catch((err) => {
          console.error("Redis connection failed, events will be logged only:", err.message);
          this.redis = null;
        });
      } catch {
        console.error("Redis initialization failed, events will be logged only");
        this.redis = null;
      }
    }
  }

  /**
   * Emit an event to Redis Streams. Falls back to console logging if Redis is unavailable.
   */
  async emit(event: ClawForgeEvent): Promise<string | null> {
    const eventWithTimestamp = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    if (!this.redis) {
      console.log("[event]", JSON.stringify(eventWithTimestamp));
      return null;
    }

    try {
      const id = await this.redis.xadd(
        this.streamKey,
        "*",
        "type",
        event.type,
        "repo_id",
        event.repoId ?? "",
        "agent_id",
        event.agentId ?? "",
        "data",
        JSON.stringify(event.data),
        "timestamp",
        eventWithTimestamp.timestamp
      );
      return id;
    } catch (error) {
      console.error("Failed to emit event to Redis:", error);
      console.log("[event-fallback]", JSON.stringify(eventWithTimestamp));
      return null;
    }
  }

  /**
   * Read events from the stream (for consumers/dashboard).
   */
  async readEvents(
    count: number = 50,
    fromId: string = "0"
  ): Promise<ClawForgeEvent[]> {
    if (!this.redis) return [];

    try {
      const results = await this.redis.xrange(
        this.streamKey,
        fromId,
        "+",
        "COUNT",
        count
      );

      return results.map(([_id, fields]) => {
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]] = fields[i + 1];
        }
        return {
          type: fieldMap.type,
          repoId: fieldMap.repo_id || undefined,
          agentId: fieldMap.agent_id || undefined,
          data: JSON.parse(fieldMap.data || "{}"),
          timestamp: fieldMap.timestamp,
        };
      });
    } catch (error) {
      console.error("Failed to read events:", error);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}
