// Dependency-free 5-field cron matcher for CI `on: schedule` pipelines.
//
// Fields (standard crontab order), all evaluated in UTC:
//   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6, Sun=0)
//
// Per-field syntax supported: `*`, `*/n` (step over the whole range),
// `a-b` (inclusive range), `a-b/n` (stepped range), `a,b,c` (lists, whose
// members may themselves be any of the above), and exact values. Anything else
// throws — a malformed cron must be a config-time error, never a silent no-run.
//
// day-of-month / day-of-week semantics follow Vixie cron: when BOTH dom and dow
// are restricted (neither is `*`), a tick matches if EITHER field matches (union,
// the historical "OR" quirk). When one is `*`, only the other constrains the day.

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6],  // day of week
];

/**
 * Parse a 5-field cron expression into a matchable spec. Throws on malformed
 * input (wrong field count, out-of-range values, bad step/range syntax).
 */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected 5 fields, got ${fields.length}`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i][0], RANGES[i][1]));
  return {
    minute, hour, dom, month, dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

function parseField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") throw new Error(`empty list member in "${field}"`);
    // Optional step suffix `.../n`.
    let step = 1;
    let body = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      body = part.slice(0, slash);
      const stepStr = part.slice(slash + 1);
      if (!/^\d+$/.test(stepStr)) throw new Error(`bad step "${part}"`);
      step = Number(stepStr);
      if (step < 1) throw new Error(`step must be >= 1 in "${part}"`);
    }

    let start: number;
    let end: number;
    if (body === "*") {
      start = lo; end = hi;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new Error(`bad range "${part}"`);
      start = Number(a); end = Number(b);
      if (start > end) throw new Error(`range start > end in "${part}"`);
    } else {
      if (!/^\d+$/.test(body)) throw new Error(`bad value "${part}"`);
      // A bare value with a step (e.g. `5/10`) means "from 5 to max, step 10".
      start = Number(body);
      end = slash >= 0 ? hi : start;
    }
    if (start < lo || end > hi) throw new Error(`value out of range [${lo},${hi}] in "${part}"`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`field "${field}" matches nothing`);
  return out;
}

/** Does the given UTC minute match the spec? */
function matchesMinute(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getUTCMinutes())) return false;
  if (!spec.hour.has(d.getUTCHours())) return false;
  if (!spec.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getUTCDate());
  const dowOk = spec.dow.has(d.getUTCDay());
  // Vixie-cron day matching: OR when both restricted, else the restricted one.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true; // both `*`
}

/**
 * True iff a scheduled tick exists in the half-open interval (last, now] — i.e.
 * the cron should fire at least once since `last`. `last === null` treats only
 * the current minute `now` as the window (first run fires if now matches),
 * which prevents a freshly-created schedule from back-filling history.
 *
 * The interval is scanned minute by minute (truncating seconds), so the same
 * minute is never counted twice across overlapping scheduler ticks: callers
 * advance `last` to `now` after firing, and `(last, now]` excludes `last`.
 *
 * Guards against unbounded scans: if `last` is more than ~370 days behind `now`
 * we only inspect the trailing window (a far-behind schedule still fires once).
 */
export function cronDue(expr: string, last: Date | null, now: Date): boolean {
  const spec = parseCron(expr);

  // Truncate to whole minutes — cron resolution is one minute.
  const nowMin = Math.floor(now.getTime() / 60_000) * 60_000;

  if (last === null) {
    // No prior run recorded: fire only if the current minute matches. We do not
    // back-fill — a schedule created at 09:05 should not instantly fire a 09:00
    // tick it "missed" before it existed.
    return matchesMinute(spec, new Date(nowMin));
  }

  // Start one minute AFTER `last` (half-open lower bound) so a minute already
  // fired for is never re-fired.
  let cursor = Math.floor(last.getTime() / 60_000) * 60_000 + 60_000;
  // Cap the lookback so a schedule that has been idle for years (or a clock
  // jump) does not spin the loop for millions of iterations. ~370 days.
  const maxSpan = 370 * 24 * 60 * 60_000;
  if (nowMin - cursor > maxSpan) cursor = nowMin - maxSpan;

  for (; cursor <= nowMin; cursor += 60_000) {
    if (matchesMinute(spec, new Date(cursor))) return true;
  }
  return false;
}
