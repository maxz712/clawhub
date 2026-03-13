import { describe, it, expect } from "vitest";
import { EventBus } from "../src/services/events.js";

describe("EventBus", () => {
  it("should gracefully handle missing Redis (fallback to logging)", async () => {
    // No Redis URL = null client, should not throw
    const bus = new EventBus(undefined);

    const id = await bus.emit({
      type: "test.event",
      repoId: "repo-1",
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
});
