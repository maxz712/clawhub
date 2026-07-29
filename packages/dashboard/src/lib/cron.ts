// Client-side 5-field cron helpers. Mirrors the API's `services/cron.ts` field
// semantics (UTC, Vixie dom/dow OR) so the settings UI can show a "next run"
// hint without a round-trip. Display-only: the server scheduler is authoritative.

export interface ParsedCron { minute: number[]; hour: number[]; dom: number[]; month: number[]; dow: number[] }

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6], // day-of-week (0 = Sunday)
];

function parseField(field: string, [min, max]: [number, number]): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      step = Number(part.slice(slash + 1));
      range = part.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    }
    let lo = min;
    let hi = max;
    if (range !== "*" && range !== "") {
      const dash = range.indexOf("-");
      if (dash !== -1) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        // A bare value WITH a step (e.g. `8/4`) means "from that value to the
        // field max, stepping" — matching the server's Vixie semantics in
        // services/cron.ts. Without a step it's a single exact value.
        lo = Number(range);
        hi = slash !== -1 ? max : lo;
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`bad range "${part}"`);
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Throws on a malformed expression. Returns the allowed values per field. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron must have 5 fields");
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i]));
  return { minute, hour, dom, month, dow };
}

function domDowMatch(c: ParsedCron, day: number, dow: number, full: { dom: boolean; dow: boolean }): boolean {
  // Vixie semantics: when both dom and dow are restricted, a tick matches if
  // EITHER matches. When only one is restricted, only that one gates.
  if (full.dom && full.dow) return c.dom.includes(day) || c.dow.includes(dow);
  return c.dom.includes(day) && c.dow.includes(dow);
}

/**
 * Next UTC fire time strictly after `from`, or null if none within ~4 years.
 * Walks minute by minute (cheap for display; the server uses the same field sets).
 */
export function nextCronFire(expr: string, from: Date = new Date()): Date | null {
  let c: ParsedCron;
  try { c = parseCron(expr); } catch { return null; }
  const full = { dom: !isFullField(expr, 2), dow: !isFullField(expr, 4) };
  const d = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    from.getUTCHours(), from.getUTCMinutes(), 0, 0,
  ));
  d.setUTCMinutes(d.getUTCMinutes() + 1); // strictly after
  const limit = new Date(d.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 4);
  while (d < limit) {
    if (
      c.month.includes(d.getUTCMonth() + 1) &&
      domDowMatch(c, d.getUTCDate(), d.getUTCDay(), full) &&
      c.hour.includes(d.getUTCHours()) &&
      c.minute.includes(d.getUTCMinutes())
    ) return new Date(d.getTime());
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

function isFullField(expr: string, idx: number): boolean {
  return (expr.trim().split(/\s+/)[idx] ?? "*") === "*";
}

/** A short human relative-time hint, e.g. "in 4h", "in 2d". UTC clock is shown separately. */
export function relativeTime(target: Date, now: Date = new Date()): string {
  const ms = target.getTime() - now.getTime();
  const past = ms < 0;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  let s: string;
  if (min < 1) s = "<1m";
  else if (min < 60) s = `${min}m`;
  else if (min < 1440) s = `${Math.round(min / 60)}h`;
  else s = `${Math.round(min / 1440)}d`;
  return past ? `${s} ago` : `in ${s}`;
}
