import { describe, it, expect } from "vitest";
import { newTraceparent, parseTraceparent } from "../src/services/logger.js";

describe("traceparent", () => {
  it("round-trips via parse", () => {
    const { traceId, spanId, header } = newTraceparent();
    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const parsed = parseTraceparent(header);
    expect(parsed).toEqual({ traceId, spanId, flags: "01" });
  });

  it("rejects malformed headers", () => {
    expect(parseTraceparent("")).toBeNull();
    expect(parseTraceparent("00-short-short-00")).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });
});
