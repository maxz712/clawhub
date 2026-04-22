import { randomBytes } from "node:crypto";

export interface LogFields { [k: string]: unknown }

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const THRESHOLD = LEVELS[configured] ?? LEVELS.info;

export function log(level: Level, msg: string, fields: LogFields = {}): void {
  if (LEVELS[level] < THRESHOLD) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  // stdout, JSON per line.
  process.stdout.write(JSON.stringify(record) + "\n");
}

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

// W3C traceparent: version-traceid-spanid-flags
export function parseTraceparent(header?: string): { traceId: string; spanId: string; flags: string } | null {
  if (!header) return null;
  const m = header.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!m) return null;
  return { traceId: m[1], spanId: m[2], flags: m[3] };
}

export function newTraceparent(): { traceId: string; spanId: string; header: string } {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return { traceId, spanId, header: `00-${traceId}-${spanId}-01` };
}
