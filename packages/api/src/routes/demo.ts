import { Hono } from "hono";
import Redis from "ioredis";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { EventBus } from "../services/events.js";
import { repositories, users } from "../models/schema.js";
import { resolveNamespace } from "../services/namespace.js";
import { metrics } from "../services/metrics.js";
import { log } from "../services/logger.js";
import { insertIssueWithNumber } from "../services/issue-number.js";

// The LIVE "file an issue, watch it ship" demo (N5, upgrading M9's recorded
// replay). A visitor picks one of the FIXED templates below; we file it as a real
// issue in the designated demo repo, whose installed Loop (scout-less dev-review)
// does the rest — the visitor watches a real developer agent ship it. Guardrails,
// per the plan: template-constrained (no free text ever reaches an agent prompt),
// tight rate caps (per-IP + global, FAIL-CLOSED — an uncapped public demo is worse
// than no demo), and ships DARK: the route 404s unless CLAWHUB_DEMO_REPO is set.
// The Loop side carries the rest of the bundle (budget row, egress none, kill).

const DEMO_TEMPLATES: Record<string, { title: string; body: string }> = {
  "health-badge": {
    title: "Add an uptime badge to the README",
    body: "Add a small status badge near the top of README.md that links to the public status page. Keep the change to README.md only.",
  },
  "issue-count": {
    title: "Show the open-issue count on the home page",
    body: "Display the number of open issues on the app's home page, fetched from the existing issues API. Small, self-contained UI change with a test.",
  },
  "footer-year": {
    title: "Footer copyright year is hardcoded",
    body: "The footer shows a hardcoded year. Compute it from the current date instead. One-file change.",
  },
};

const PER_IP_DAILY = Number(process.env.CLAWHUB_DEMO_PER_IP_DAILY) || 3;
const GLOBAL_DAILY = Number(process.env.CLAWHUB_DEMO_GLOBAL_DAILY) || 20;

let client: Redis | null = null;
function redis(): Redis | null {
  if (client) return client;
  try {
    client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    client.on("error", () => { /* handled per-call */ });
  } catch { client = null; }
  return client;
}

/** INCR a daily cap key; true = within cap. FAIL-CLOSED on Redis trouble. */
async function underDailyCap(key: string, cap: number): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  try {
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, 86_400);
    return n <= cap;
  } catch { return false; }
}

export function createDemoRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();

  // What the demo offers (template ids + titles) — lets the landing page render
  // the picker without hardcoding. 404s when the demo is dark, same as the POST.
  app.get("/demo/templates", c => {
    if (!process.env.CLAWHUB_DEMO_REPO) return c.json({ error: "demo not enabled" }, 404);
    return c.json({ templates: Object.entries(DEMO_TEMPLATES).map(([id, t]) => ({ id, title: t.title })) });
  });

  app.post("/demo/issue", async c => {
    const target = process.env.CLAWHUB_DEMO_REPO;
    if (!target) return c.json({ error: "demo not enabled" }, 404);
    const [ns, repoName] = target.split("/");
    if (!ns || !repoName) return c.json({ error: "demo misconfigured" }, 500);

    const body = await c.req.json().catch(() => ({})) as { template?: string };
    const template = typeof body.template === "string" ? DEMO_TEMPLATES[body.template] : undefined;
    if (!template) return c.json({ error: `template must be one of ${Object.keys(DEMO_TEMPLATES).join(", ")}` }, 400);

    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!(await underDailyCap(`clawhub:demo:ip:${ip}`, PER_IP_DAILY)) || !(await underDailyCap("clawhub:demo:global", GLOBAL_DAILY))) {
      metrics.inc("clawhub_demo_rejected_total", { reason: "rate_capped" });
      return c.json({ error: "demo rate limit reached — try again tomorrow" }, 429);
    }

    const nsRow = await resolveNamespace(db, ns);
    if (!nsRow) return c.json({ error: "demo misconfigured" }, 500);
    const repo = (await db.select().from(repositories).where(and(eq(repositories.namespaceId, nsRow.id), eq(repositories.name, repoName))).limit(1))[0];
    if (!repo) return c.json({ error: "demo misconfigured" }, 500);
    // Attribute the issue to the demo repo's owning USER (a real accountable row).
    const owner = repo.namespaceType === "user" ? (await db.select({ id: users.id }).from(users).where(eq(users.id, repo.namespaceId)).limit(1))[0] : null;
    if (!owner) return c.json({ error: "demo misconfigured" }, 500);

    // Shared race-safe allocator (#119) — the public demo is exactly the surface
    // where two anonymous filings land in the same millisecond.
    const { number } = await insertIssueWithNumber(db, {
      repoId: repo.id,
      title: template.title, body: `${template.body}\n\n_Filed by the public demo._`,
      labels: ["demo"], priority: "normal",
      createdByKind: "human", createdById: owner.id,
    });
    await events.publish({ type: "issue.opened", repoId: repo.id, issueNumber: number, actorKind: "human", actorId: owner.id });
    metrics.inc("clawhub_demo_issue_total", {});
    log("info", "demo_issue_filed", { repoId: repo.id, number, ip });

    const base = (process.env.CLAWHUB_DASHBOARD_URL || "https://useclawhub.com").replace(/\/+$/, "");
    return c.json({ number, url: `${base}/repos/${ns}/${repoName}/issues/${number}` }, 201);
  });

  return app;
}
