import { describe, it, expect } from "vitest";
import { EventBus } from "../src/services/events.js";

describe("EventBus", () => {
  it("should gracefully handle missing Redis (fallback to logging)", async () => {
    // No Redis URL = null client, should not throw
    const bus = new EventBus(undefined);

    const id = await bus.emit({
      type: "test.event",
      repoId: "repo-1",
      actorId: "agent-1",
      actorType: "agent",
      data: { message: "hello" },
      timestamp: new Date().toISOString(),
    });

    expect(id).toBeNull();
    await bus.close();
  });

  it("should return empty array for readEvents when no Redis", async () => {
    const bus = new EventBus(undefined);
    const events = await bus.readEvents();
    expect(events).toEqual([]);
    await bus.close();
  });

  it("should accept actorId and actorType in event payload", async () => {
    const bus = new EventBus(undefined);

    // Should not throw when emitting with v2 actor fields
    const id = await bus.emit({
      type: "change.merged",
      repoId: "repo-1",
      actorId: "user-1",
      actorType: "human",
      data: { changeId: "change-1" },
      timestamp: new Date().toISOString(),
    });

    expect(id).toBeNull(); // no Redis, so null
    await bus.close();
  });
});
