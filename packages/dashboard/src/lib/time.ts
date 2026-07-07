// Human-friendly relative-time formatting for feed / list / runs views (#32).
// Renders full-word relative times — "3 hours ago", "yesterday", "2 weeks ago"
// — instead of raw ISO / locale strings, so activity reads at a glance.
//
// Note: `lib/cron.ts` has its OWN terse `relativeTime` ("in 4h", "3d ago") used
// for cron next-run HINTS (it formats FUTURE times too); this one is purpose-
// built for PAST timestamps in the activity surfaces and is intentionally
// separate so neither changes the other.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * Format a timestamp as a friendly relative string, e.g. "just now",
 * "5 minutes ago", "3 hours ago", "yesterday", "2 weeks ago", "3 months ago".
 * Accepts an ISO string, epoch millis, or a Date. Returns "" for a missing /
 * unparseable value, and falls back to a future-tense form for times ahead of
 * `now` (rare, but clock skew happens).
 */
export function formatRelativeTime(input: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (input === null || input === undefined) return "";
  const then = input instanceof Date ? input : new Date(input);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return "";

  const diffSec = Math.round((now.getTime() - ms) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec < 0;

  if (abs < 45) return "just now";

  // Pick the coarsest unit that fits.
  let value: string;
  if (abs < HOUR) {
    value = plural(Math.round(abs / MINUTE), "minute");
  } else if (abs < DAY) {
    value = plural(Math.round(abs / HOUR), "hour");
  } else if (abs < 2 * DAY) {
    value = future ? "tomorrow" : "yesterday";
    return value;
  } else if (abs < WEEK) {
    value = plural(Math.round(abs / DAY), "day");
  } else if (abs < MONTH) {
    value = plural(Math.round(abs / WEEK), "week");
  } else if (abs < YEAR) {
    value = plural(Math.round(abs / MONTH), "month");
  } else {
    value = plural(Math.round(abs / YEAR), "year");
  }

  if (future && value !== "tomorrow") {
    // Re-phrase "3 hours ago" → "in 3 hours" for the uncommon future case.
    return value.replace(/^(.*) ago$/, "in $1");
  }
  return value;
}

/** An absolute, locale-formatted timestamp — used as a hover `title` alongside
 *  the relative label so the exact time is always one hover away. */
export function absoluteTime(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined) return "";
  const then = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(then.getTime())) return "";
  return then.toLocaleString();
}
