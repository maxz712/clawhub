// GitHub App (N2) — webhook intake. Public + HMAC-verified (never the auth
// middleware): GitHub POSTs installation + pull_request events here; we persist
// installations and kick off the mirror-and-verify flow. Responds 200 fast —
// the mirror runs detached so a slow git fetch never trips GitHub's 10s timeout.
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { githubInstallations, users } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import type { ChangeRefService } from "../services/change-refs.js";
import type { EventBus } from "../services/events.js";
import { githubAppConfig, verifyWebhookSignature } from "../services/github-app.js";
import { mirrorPullRequest } from "../services/github-mirror.js";
import { log } from "../services/logger.js";
import { metrics } from "../services/metrics.js";

interface InstallationPayload {
  action?: string;
  installation?: {
    id: number;
    account?: { login: string; id: number; type: string };
    repository_selection?: string;
  };
  sender?: { login: string; id: number };
}
interface PullRequestPayload {
  action?: string;
  number?: number;
  installation?: { id: number };
  repository?: { name: string; owner: { login: string } };
  pull_request?: { number: number; state: string; draft?: boolean };
}

export function createGithubAppRoutes(db: DB, git: GitService, changeRefs: ChangeRefService, events: EventBus): Hono {
  const app = new Hono();

  // Health/affordance probe (public, no secrets): is the App wired up?
  app.get("/app", (c) => {
    const cfg = githubAppConfig();
    return c.json({ configured: !!cfg, slug: process.env.GITHUB_APP_SLUG ?? "useclawhub", appId: cfg?.appId ?? null });
  });

  app.post("/webhook", async (c) => {
    const cfg = githubAppConfig();
    if (!cfg) return c.json({ error: "github app not configured" }, 503);
    const raw = await c.req.text();
    const sig = c.req.header("x-hub-signature-256");
    if (!verifyWebhookSignature(raw, sig, cfg.webhookSecret)) {
      metrics.inc("clawhub_github_webhook_total", { event: "unknown", result: "bad_signature" });
      return c.json({ error: "bad signature" }, 401);
    }
    const eventName = c.req.header("x-github-event") ?? "unknown";
    let payload: InstallationPayload & PullRequestPayload;
    try { payload = JSON.parse(raw); } catch { return c.json({ error: "bad json" }, 400); }

    try {
      if (eventName === "ping") {
        metrics.inc("clawhub_github_webhook_total", { event: "ping", result: "ok" });
        return c.json({ ok: true });
      }

      if (eventName === "installation" || eventName === "installation_repositories") {
        const inst = payload.installation;
        if (inst) {
          const action = payload.action;
          if (action === "deleted") {
            await db.delete(githubInstallations).where(eq(githubInstallations.installationId, String(inst.id)));
          } else {
            // Best-effort: link this installation to the ClawHub user whose GitHub
            // login matches the account (so the dashboard can show it as "yours").
            const login = inst.account?.login ?? payload.sender?.login ?? "";
            const owner = login ? (await db.select({ id: users.id }).from(users).where(eq(users.username, login)).limit(1))[0] : undefined;
            const row = {
              installationId: String(inst.id),
              accountLogin: login,
              accountType: inst.account?.type ?? "User",
              accountId: inst.account?.id ? String(inst.account.id) : null,
              repoSelection: inst.repository_selection ?? "selected",
              ownerUserId: owner?.id ?? null,
              suspendedAt: action === "suspend" ? new Date() : null,
              updatedAt: new Date(),
            };
            await db.insert(githubInstallations).values(row)
              .onConflictDoUpdate({ target: githubInstallations.installationId, set: { ...row } });
          }
        }
        metrics.inc("clawhub_github_webhook_total", { event: eventName, result: "ok" });
        return c.json({ ok: true });
      }

      if (eventName === "pull_request") {
        const action = payload.action ?? "";
        const wanted = action === "opened" || action === "synchronize" || action === "reopened" || action === "ready_for_review";
        const inst = payload.installation?.id;
        const owner = payload.repository?.owner?.login;
        const repo = payload.repository?.name;
        const prNumber = payload.pull_request?.number ?? payload.number;
        if (wanted && inst && owner && repo && prNumber) {
          metrics.inc("clawhub_github_webhook_total", { event: "pull_request", result: "mirror" });
          // Detached: return 200 immediately; the mirror + review runs in the background.
          void mirrorPullRequest({ db, git, changeRefs, events, cfg, installationId: String(inst), owner, repo, prNumber })
            .catch(e => log("warn", "github_mirror_dispatch_failed", { owner, repo, prNumber, error: (e as Error).message }));
        } else {
          metrics.inc("clawhub_github_webhook_total", { event: "pull_request", result: "ignored" });
        }
        return c.json({ ok: true });
      }

      metrics.inc("clawhub_github_webhook_total", { event: eventName, result: "ignored" });
      return c.json({ ok: true });
    } catch (e) {
      log("warn", "github_webhook_error", { event: eventName, error: (e as Error).message });
      metrics.inc("clawhub_github_webhook_total", { event: eventName, result: "error" });
      // 200 anyway — GitHub retries on non-2xx, and the mirror path records its own errors.
      return c.json({ ok: false });
    }
  });

  return app;
}
