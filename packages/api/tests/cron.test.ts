import { describe, it, expect } from "vitest";
import { cronDue, parseCron } from "../src/services/cron.js";

// Build a UTC Date from y/m/d h:m for readable test fixtures.
const utc = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));

describe("parseCron", () => {
  it("rejects wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("* * * * * *")).toThrow();
    expect(() => parseCron("")).toThrow();
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow();   // minute max 59
    expect(() => parseCron("* 24 * * *")).toThrow();   // hour max 23
    expect(() => parseCron("* * 0 * *")).toThrow();    // dom min 1
    expect(() => parseCron("* * * 13 *")).toThrow();   // month max 12
    expect(() => parseCron("* * * * 7")).toThrow();    // dow max 6
  });

  it("rejects malformed syntax", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow();  // step must be >= 1
    expect(() => parseCron("5-3 * * * *")).toThrow();  // start > end
    expect(() => parseCron("a * * * *")).toThrow();    // non-numeric
    expect(() => parseCron("1,,2 * * * *")).toThrow(); // empty list member
  });

  it("accepts the supported syntaxes", () => {
    expect(() => parseCron("* * * * *")).not.toThrow();
    expect(() => parseCron("*/5 * * * *")).not.toThrow();
    expect(() => parseCron("0-30/10 * * * *")).not.toThrow();
    expect(() => parseCron("0,15,30,45 * * * *")).not.toThrow();
    expect(() => parseCron("0 9-17 * * 1-5")).not.toThrow();
  });
});

describe("cronDue — first run (last = null)", () => {
  it("fires only when the current minute matches; never back-fills", () => {
    // "0 0 * * *" = midnight. At 00:00 it is due; at 00:05 it is not (no back-fill).
    expect(cronDue("0 0 * * *", null, utc(2026, 6, 12, 0, 0))).toBe(true);
    expect(cronDue("0 0 * * *", null, utc(2026, 6, 12, 0, 5))).toBe(false);
  });
});

describe("cronDue — */5 step", () => {
  const expr = "*/5 * * * *";
  it("is due when a multiple-of-5 minute falls in (last, now]", () => {
    // last 12:01, now 12:05 → tick at 12:05 is included.
    expect(cronDue(expr, utc(2026, 6, 12, 12, 1), utc(2026, 6, 12, 12, 5))).toBe(true);
  });
  it("is not due across a gap that skips every 5-minute tick", () => {
    // last 12:06, now 12:09 → ticks would be 12:07,08,09 — none multiple of 5.
    expect(cronDue(expr, utc(2026, 6, 12, 12, 6), utc(2026, 6, 12, 12, 9))).toBe(false);
  });
  it("never fires twice for the same minute (half-open lower bound)", () => {
    // After firing at 12:05, advance last=now=12:05. A re-check at the same
    // minute must be false — (12:05, 12:05] is empty.
    expect(cronDue(expr, utc(2026, 6, 12, 12, 5), utc(2026, 6, 12, 12, 5))).toBe(false);
    // And the very next minute (12:06) still isn't a 5-tick.
    expect(cronDue(expr, utc(2026, 6, 12, 12, 5), utc(2026, 6, 12, 12, 6))).toBe(false);
    // 12:10 is the next 5-tick — due again.
    expect(cronDue(expr, utc(2026, 6, 12, 12, 5), utc(2026, 6, 12, 12, 10))).toBe(true);
  });
});

describe("cronDue — ranges and lists", () => {
  it("hour range 9-17 with explicit minute", () => {
    const expr = "30 9-17 * * *"; // :30 past every hour 09..17
    expect(cronDue(expr, utc(2026, 6, 12, 9, 29), utc(2026, 6, 12, 9, 30))).toBe(true);
    expect(cronDue(expr, utc(2026, 6, 12, 8, 29), utc(2026, 6, 12, 8, 31))).toBe(false); // 08:30 out of range
    expect(cronDue(expr, utc(2026, 6, 12, 17, 29), utc(2026, 6, 12, 17, 31))).toBe(true); // 17:30 in range
    expect(cronDue(expr, utc(2026, 6, 12, 18, 29), utc(2026, 6, 12, 18, 31))).toBe(false); // 18:30 out
  });
  it("minute list", () => {
    const expr = "0,15,30,45 * * * *";
    expect(cronDue(expr, utc(2026, 6, 12, 12, 14), utc(2026, 6, 12, 12, 15))).toBe(true);
    expect(cronDue(expr, utc(2026, 6, 12, 12, 15), utc(2026, 6, 12, 12, 16))).toBe(false);
  });
});

describe("cronDue — dom / dow (Vixie OR semantics)", () => {
  it("ORs dom and dow when both are restricted", () => {
    // "0 0 13 * 5" = midnight on the 13th OR on Friday(5).
    // 2026-06-12 is a Friday → due via dow even though it is the 12th.
    expect(cronDue("0 0 13 * 5", utc(2026, 6, 11, 23, 59), utc(2026, 6, 12, 0, 0))).toBe(true);
    // 2026-06-13 is a Saturday → due via dom (the 13th) even though not Friday.
    expect(cronDue("0 0 13 * 5", utc(2026, 6, 12, 23, 59), utc(2026, 6, 13, 0, 0))).toBe(true);
    // 2026-06-14 is a Sunday, not the 13th → not due.
    expect(cronDue("0 0 13 * 5", utc(2026, 6, 13, 23, 59), utc(2026, 6, 14, 0, 0))).toBe(false);
  });
  it("uses only dom when dow is *", () => {
    // "0 0 1 * *" fires on the 1st of the month only.
    expect(cronDue("0 0 1 * *", utc(2026, 6, 30, 23, 59), utc(2026, 7, 1, 0, 0))).toBe(true);
    expect(cronDue("0 0 1 * *", utc(2026, 7, 1, 0, 0), utc(2026, 7, 2, 0, 0))).toBe(false);
  });
  it("uses only dow when dom is *", () => {
    // "0 0 * * 0" fires Sundays. 2026-06-14 is a Sunday.
    expect(cronDue("0 0 * * 0", utc(2026, 6, 13, 0, 0), utc(2026, 6, 14, 0, 0))).toBe(true);
    expect(cronDue("0 0 * * 0", utc(2026, 6, 14, 0, 0), utc(2026, 6, 15, 0, 0))).toBe(false); // Monday
  });
});

describe("cronDue — rollover", () => {
  it("fires a daily tick across an hour/day boundary scan", () => {
    // last 23:58, now 00:02 next day → midnight tick (00:00) is in (last, now].
    expect(cronDue("0 0 * * *", utc(2026, 6, 11, 23, 58), utc(2026, 6, 12, 0, 2))).toBe(true);
  });
  it("fires across a month boundary", () => {
    // Daily midnight; last 2026-06-30 23:59, now 2026-07-01 00:01.
    expect(cronDue("0 0 * * *", utc(2026, 6, 30, 23, 59), utc(2026, 7, 1, 0, 1))).toBe(true);
  });
  it("does not over-scan a very stale last (still resolves)", () => {
    // last 3 years behind: a daily tick still exists in the trailing window.
    expect(cronDue("0 0 * * *", utc(2023, 1, 1, 0, 0), utc(2026, 6, 12, 0, 0))).toBe(true);
  });
});
