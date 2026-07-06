import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents } from "../models/schema.js";
import { hashToken, randomToken } from "./auth.js";
import { ensureDefaultAccessRoles } from "./access-roles.js";
import { log } from "./logger.js";

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
 * Find-or-create the user's ONE personal agent WITHOUT issuing a token.
 * v3 (docs/redesign-v3.md §3): this is the DEFAULT PERSONAL AGENT — created
 * dormant on register (no workflow attachment, zero runs, zero spend), it
 * doubles as the user's wrapper identity (paste its token into a local tool)
 * and is one click from deployment. It holds the seeded Developer role (no
 * change:merge); platform key source is simply the deploy-time default.
 * The created row gets a random non-matching tokenHash sentinel, so no
 * usable credential exists until the user explicitly mints one via
 * POST /agents/personal.
 */
export async function ensurePersonalAgent(db: DB, userId: string, email: string): Promise<typeof agents.$inferSelect> {
  const existing = (await db.select().from(agents)
    .where(and(eq(agents.associatedUserId, userId), eq(agents.isPersonal, true))).limit(1))[0];
  if (existing) return existing;
  const name = await uniquePersonalName(db, email);
  // Developer by default: push + review + trigger, never merge. Best-effort —
  // a seeding failure must not block registration.
  let accessRoleId: string | null = null;
  try {
    const roles = await ensureDefaultAccessRoles(db, userId);
    accessRoleId = roles.find(r => r.isBuiltin && r.name === "Developer")?.id ?? null;
  } catch { /* roleless personal agent keeps legacy behavior */ }
  const inserted = (await db.insert(agents).values({
    name,
    tokenHash: await hashToken(randomToken(12)),
    isPersonal: true,
    associatedUserId: userId,
    createdByUserId: userId,
    accessRoleId,
    gitAuthorName: name,
    gitAuthorEmail: `${name}@${agentEmailDomain()}`,
    capabilities: { push: true, review: true },
  }).returning())[0];
  return inserted;
}

/**
 * Registration hook (v3): create the dormant default agent for a brand-new
 * user. Fire-and-forget — never blocks or fails the register/login path.
 * Kill switch: CLAWHUB_DISABLE_DEFAULT_PERSONAL_AGENT=1.
 */
export function ensurePersonalAgentInBackground(db: DB, userId: string, email: string): void {
  if (process.env.CLAWHUB_DISABLE_DEFAULT_PERSONAL_AGENT === "1") return;
  void ensurePersonalAgent(db, userId, email).catch(e =>
    log("warn", "default_personal_agent_failed", { userId, err: (e as Error).message }));
}
