// Minimal Sentry client — just the /envelope POST to `<dsn>/store/` that
// matches the public SDK wire protocol. No sdk dep.

const DSN = process.env.SENTRY_DSN ?? "";

interface SentryDsn { host: string; projectId: string; publicKey: string }

function parse(dsn: string): SentryDsn | null {
  const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
  if (!m) return null;
  return { publicKey: m[1], host: m[2], projectId: m[3] };
}

export async function captureException(err: Error, extra: Record<string, unknown> = {}): Promise<void> {
  const dsn = parse(DSN);
  if (!dsn) return;
  const eventId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const payload = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    logger: "clawhub",
    exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames: (err.stack ?? "").split("\n").slice(1, 10).map(s => ({ filename: s })) } }] },
    extra,
  };
  try {
    await fetch(`https://${dsn.host}/api/${dsn.projectId}/store/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=clawhub/0.1`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Sentry failures must never throw. Swallow.
  }
}
