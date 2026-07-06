import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents } from "../models/schema.js";
import { hashToken, randomToken } from "./auth.js";

// Default git-author email domain for agents. Derives from the configured
// public host (so a self-hosted instance authors from its own domain) and
// defaults to a domain ClawHub actually operates — never the dead `clawhub.dev`.
export function agentEmailDomain(): string {
  const configured = process.env.CLAWHUB_PUBLIC_URL;
  if (configured) {
    try {
      const host = new URL(configured).hostname.replace(/^www\./, "");
      if (host) return `agents.${host}`;
    } catch { /* fall through to default */ }
  }
  return "agents.useclawhub.com";
}

// Personal-agent name from the email local part: slugified to the agents.name
// regex, suffix "-agent", and a short random tail on collision.
export async function uniquePersonalName(db: DB, email: string): Promise<string> {
  const local = email.split("@")[0] ?? "user";
  let base = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!base) base = "user";
  const candidate = `${base}-agent`;
  const taken = (await db.select().from(agents).where(eq(agents.name, candidate)).limit(1))[0];
  if (!taken) return candidate;
  const suffix = randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  return `${base}-agent-${suffix}`;
}

/**
 * Find-or-create the user's one personal agent WITHOUT issuing a token.
 * For server-internal attribution (e.g. a logged-in human runs an import and
 * the run is recorded as their personal agent) — the created row gets a
 * random non-matching tokenHash sentinel, so no usable credential exists
 * until the user explicitly mints one via POST /agents/personal.
 */
export async function ensurePersonalAgent(db: DB, userId: string, email: string): Promise<typeof agents.$inferSelect> {
  const existing = (await db.select().from(agents)
    .where(and(eq(agents.associatedUserId, userId), eq(agents.isPersonal, true))).limit(1))[0];
  if (existing) return existing;
  const name = await uniquePersonalName(db, email);
  const inserted = (await db.insert(agents).values({
    name,
    tokenHash: await hashToken(randomToken(12)),
    isPersonal: true,
    associatedUserId: userId,
    gitAuthorName: name,
    gitAuthorEmail: `${name}@${agentEmailDomain()}`,
    capabilities: { push: true, review: true },
  }).returning())[0];
  return inserted;
}
