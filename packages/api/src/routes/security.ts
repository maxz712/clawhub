import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { sastFindings, sastRules, vulnAdvisories, vulnFindings } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { DEFAULT_RULES, seedDefaultRules } from "../services/sast.js";
import { isPlatformAdminEmail } from "./admin.js";

export function createSecurityRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Dependency findings
  app.get("/:ns/:repo/security/vulns", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select({
      f: vulnFindings,
      a: vulnAdvisories,
    }).from(vulnFindings).innerJoin(vulnAdvisories, eq(vulnAdvisories.id, vulnFindings.advisoryId))
      .where(eq(vulnFindings.repoId, repo.id))
      .orderBy(desc(vulnFindings.createdAt));
    return c.json({
      findings: rows.map(r => ({
        id: r.f.id,
        advisoryId: r.f.advisoryId,
        manifestPath: r.f.manifestPath,
        installedVersion: r.f.installedVersion,
        status: r.f.status,
        advisory: r.a,
        issueId: r.f.issueId,
        createdAt: r.f.createdAt,
      })),
    });
  });

  app.post("/:ns/:repo/security/vulns/:id/resolve", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await db.update(vulnFindings).set({ status: "resolved" }).where(and(eq(vulnFindings.id, c.req.param("id")), eq(vulnFindings.repoId, repo.id)));
    return c.json({ ok: true });
  });

  // SAST findings.
  app.get("/:ns/:repo/security/sast", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select({ f: sastFindings, r: sastRules })
      .from(sastFindings).innerJoin(sastRules, eq(sastRules.id, sastFindings.ruleId))
      .where(eq(sastFindings.repoId, repo.id))
      .orderBy(desc(sastFindings.createdAt));
    return c.json({
      findings: rows.map(x => ({
        id: x.f.id,
        path: x.f.path,
        line: x.f.line,
        excerpt: x.f.excerpt,
        severity: x.f.severity,
        status: x.f.status,
        changeId: x.f.changeId,
        rule: { identifier: x.r.identifier, message: x.r.message },
        createdAt: x.f.createdAt,
      })),
    });
  });

  app.post("/:ns/:repo/security/sast/:id/resolve", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await db.update(sastFindings).set({ status: "resolved" }).where(and(eq(sastFindings.id, c.req.param("id")), eq(sastFindings.repoId, repo.id)));
    return c.json({ ok: true });
  });

  // Rule management.
  app.get("/:ns/:repo/security/rules", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(sastRules).where(eq(sastRules.repoId, repo.id));
    return c.json({ rules: rows, defaults: DEFAULT_RULES });
  });

  app.post("/:ns/:repo/security/rules", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { identifier?: string; pattern?: string; flags?: string; severity?: "low"|"medium"|"high"|"critical"; message?: string; languages?: string[] };
    if (!body.identifier || !body.pattern || !body.message) throw new ValidationError("identifier, pattern, message required");
    // ReDoS guard: a stored rule pattern is run synchronously against every pushed
    // line in the shared post-push worker, so a catastrophic-backtracking pattern is
    // a cross-tenant DoS. Bound length + reject obviously-exponential constructs at
    // creation, and validate it compiles. (sast.ts also bounds the input it tests.)
    assertSafeSastPattern(body.pattern);
    const [row] = await db.insert(sastRules).values({
      repoId: repo.id,
      identifier: body.identifier,
      pattern: body.pattern,
      flags: body.flags ?? "",
      severity: body.severity ?? "medium",
      message: body.message,
      languages: body.languages ?? [],
    }).returning();
    return c.json({ rule: row }, 201);
  });

  app.delete("/:ns/:repo/security/rules/:id", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await db.delete(sastRules).where(and(eq(sastRules.id, c.req.param("id")), eq(sastRules.repoId, repo.id)));
    return c.json({ ok: true });
  });

  return app;
}

// Reject SAST rule patterns that are too long or carry obviously-catastrophic
// backtracking structure (nested quantifiers like (a+)+ / (a*)* / (.+)+ /
// quantified alternations) before they are stored and run against every push.
// Deterministic heuristic (no new deps) — the goal is to stop the easy ReDoS
// footguns, not to prove every pattern linear. The 2KB input bound in sast.ts is
// the runtime backstop.
const MAX_SAST_PATTERN_LEN = 1000;
const CATASTROPHIC_REGEX_SHAPES: RegExp[] = [
  /\([^)]*[+*][^)]*\)\s*[+*]/,        // (…+…)+ / (…*…)* — nested quantifier
  /\([^)]*[+*][^)]*\)\s*\{\d+,?\d*\}/, // (…+…){n,} — nested quantifier via bound
  /\([^)]*\|[^)]*\)\s*[+*]/,           // (a|ab)+ — quantified ambiguous alternation
];
export function assertSafeSastPattern(pattern: string): void {
  if (pattern.length > MAX_SAST_PATTERN_LEN) throw new ValidationError(`pattern too long (max ${MAX_SAST_PATTERN_LEN} chars)`);
  for (const shape of CATASTROPHIC_REGEX_SHAPES) {
    if (shape.test(pattern)) throw new ValidationError("pattern rejected: nested/ambiguous quantifier risks catastrophic backtracking");
  }
  try { new RegExp(pattern); } catch (e) { throw new ValidationError(`invalid regex: ${(e as Error).message}`); }
}

// Platform-operator security routes that live at the bare `/api/v1` prefix
// (not repo-scoped): global advisory ingestion + default-rule seeding.
//
// These are deliberately NOT folded into `createSecurityRoutes` above, because
// that router installs `app.use("*", authMiddleware)`. Mounting such a router at
// the broad `/api/v1` prefix registers that wildcard auth ahead of every public
// route declared later in app.ts (Hono matches middleware in registration
// order), which silently 401s `/api/v1/public/status`, `/public/marketplace`,
// the public billing surface, `/security/scan-diff`, etc. Here we attach auth
// PER ROUTE so mounting at `/api/v1` adds no namespace-wide wildcard.
export function createSecurityAdminRoutes(db: DB): Hono {
  const app = new Hono();

  // Advisory ingestion — platform operator uploads a batch.
  app.post("/advisories", authMiddleware, async c => {
    const p = c.get("tokenPayload");
    // Writing to the GLOBAL advisory DB is a platform-operator action, not a
    // per-user one — gate it on platform admin (was previously any signed-in user).
    if (p.kind !== "user") throw new AuthError("users only");
    if (!isPlatformAdminEmail(p.email)) throw new ForbiddenError("platform admin required");
    const body = await c.req.json().catch(() => ({})) as { advisories?: Array<{ identifier: string; ecosystem: string; packageName: string; vulnerableRange: string; patchedRange?: string; severity?: "low"|"medium"|"high"|"critical"; summary: string; url?: string; publishedAt?: string }> };
    if (!Array.isArray(body.advisories)) throw new ValidationError("advisories array required");
    let inserted = 0;
    for (const a of body.advisories) {
      const [row] = await db.insert(vulnAdvisories).values({
        identifier: a.identifier,
        ecosystem: a.ecosystem,
        packageName: a.packageName,
        vulnerableRange: a.vulnerableRange,
        patchedRange: a.patchedRange ?? null,
        severity: a.severity ?? "medium",
        summary: a.summary,
        url: a.url ?? null,
        publishedAt: a.publishedAt ? new Date(a.publishedAt) : null,
      }).onConflictDoNothing().returning();
      if (row) inserted++;
    }
    return c.json({ inserted });
  });

  app.post("/security/seed-defaults", authMiddleware, async c => {
    const p = c.get("tokenPayload");
    // Seeding GLOBAL default SAST rules (repoId null, matched by every repo) is a
    // platform-operator action. Rules are also seeded on boot (app.ts), so this
    // is a manual re-sync — admin-only. (Was previously any signed-in user.)
    if (p.kind !== "user") throw new AuthError("users only");
    if (!isPlatformAdminEmail(p.email)) throw new ForbiddenError("platform admin required");
    await seedDefaultRules(db);
    return c.json({ ok: true, seeded: DEFAULT_RULES.length });
  });

  return app;
}
