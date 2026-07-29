import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { ChangeRefService } from "./change-refs.js";
import type { EventBus } from "./events.js";
import { resolveNamespace } from "./repo-resolver.js";
import { processPush, type PushedRef } from "./post-push.js";
import { log } from "./logger.js";
import { pushJobActor, type PushJob } from "./push-queue.js";
import { admitMagicRefs, parseMagicRef } from "./ref-rewriter.js";

const pexec = promisify(execFile);

export interface RunnerDeps {
  db: DB;
  git: GitService;
  changeRefs: ChangeRefService;
  events: EventBus;
}

/**
 * Drains a {@link PushJob}: discovers updated branch heads, reconstructs
 * {@link PushedRef[]}, and hands off to the existing {@link processPush}
 * pipeline. This is the body of the worker — kept independent of any queue
 * so it can also run in-process as a Redis-down fallback.
 */
export async function runPostPushJob(deps: RunnerDeps, job: PushJob): Promise<void> {
  const { db, git, changeRefs, events } = deps;
  const actor = pushJobActor(job);
  if (!actor) { log("warn", "post_push_job_no_actor", { ns: job.namespace, repo: job.repoName }); return; }
  try {
    const ns = await resolveNamespace(db, job.namespace);
    if (!ns) return;
    const repo = (await db.select().from(repositories).where(and(
      eq(repositories.namespaceType, ns.kind),
      eq(repositories.namespaceId, ns.id),
      eq(repositories.name, job.repoName),
    )).limit(1))[0];
    if (!repo) return;

    // Walk *all* refs the receive-pack might have written. We care about three
    // shapes: refs/heads/* (direct branch pushes — legacy mode), refs/for/* and
    // refs/clawhub/for/* (magic refs — Phase 2 ref-per-change). The latter two
    // are admitted server-side: a Change ID is allocated, the commits are
    // written to refs/clawhub/changes/<id>, and the magic ref is deleted so it
    // does not persist.
    const dir = git.pathOf(job.namespace, job.repoName);
    const allRefs: Record<string, string> = {};
    try {
      const out = await git.open(job.namespace, job.repoName).raw(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/for/", "refs/clawhub/for/"]);
      for (const line of out.split("\n").map(s => s.trim()).filter(Boolean)) {
        const [refname, sha] = line.split(/\s+/);
        allRefs[refname] = sha;
      }
    } catch { return; }

    const magicAdmits: Array<{ ref: string; newSha: string; targetBranch: string }> = [];
    const pushedRefs: PushedRef[] = [];

    for (const [refname, sha] of Object.entries(allRefs)) {
      const magic = parseMagicRef(refname);
      if (magic) {
        magicAdmits.push({ ref: refname, newSha: sha, targetBranch: magic.target });
        continue;
      }
      const shortName = refname.startsWith("refs/heads/") ? refname.slice("refs/heads/".length) : refname;
      if (job.priorHeads[shortName] !== sha) {
        pushedRefs.push({ ref: refname, oldSha: job.priorHeads[shortName] ?? "0".repeat(40), newSha: sha });
      }
    }
    // Branch deletions — inferred by diffing the receive-time snapshot against a
    // worker-time read. NEVER for `magic/*` branches (#96): those are created and
    // cleaned up SERVER-SIDE (admitMagicRefs / merge), so their lifecycle is not
    // observable through this cross-time diff — a magic branch that appeared or
    // vanished between another push's receive and its worker pass read as "this
    // push deleted it", and the retraction below silently destroyed an innocent
    // PENDING Change (observed live twice on 2026-07-30: changes 6077db69 +
    // 1d4e8b88 — rows gone, refs left dangling, no audit trail). Genuine human/
    // agent deletions of ordinary branches keep retracting as designed.
    for (const name of Object.keys(job.priorHeads)) {
      if (name.startsWith("magic/")) continue;
      if (!(`refs/heads/${name}` in allRefs)) {
        pushedRefs.push({ ref: `refs/heads/${name}`, oldSha: job.priorHeads[name], newSha: "0".repeat(40) });
      }
    }

    if (magicAdmits.length) {
      try {
        const admitted = await admitMagicRefs({ db, git, namespace: job.namespace, repoName: job.repoName, actor, refs: magicAdmits });
        // Delete the input refs and surface the new synthetic-branch refs as
        // "pushed" so the normal post-push pipeline runs trailers/scope/etc.
        for (const m of magicAdmits) {
          try { await pexec("git", ["-C", dir, "update-ref", "-d", m.ref]); } catch { /* best-effort */ }
        }
        // For trailer aggregation we need a branch name that matches the synthetic
        // branch we stored on the Change row.
        for (let i = 0; i < admitted.length; i++) {
          const m = magicAdmits[i];
          const synthBranch = `magic/${m.targetBranch}/${m.newSha.slice(0, 12)}`;
          pushedRefs.push({ ref: `refs/heads/${synthBranch}`, oldSha: "0".repeat(40), newSha: m.newSha });
        }
      } catch (e) {
        log("warn", "magic_admit_failed", { err: (e as Error).message });
      }
    }

    if (!pushedRefs.length) return;

    // First push to an empty repo: adopt the pushed branch as the default
    // branch, like GitHub. Without this, a repo created by pushing `master`
    // keeps the schema default (`main`) and every later push opens a Change
    // against a branch that does not exist.
    let defaultBranch = repo.defaultBranch;
    if (!(`refs/heads/${defaultBranch}` in allRefs)) {
      const created = pushedRefs.filter(p => p.ref.startsWith("refs/heads/") && /^0+$/.test(p.oldSha));
      const adopted = created.find(p => p.ref === "refs/heads/main" || p.ref === "refs/heads/master") ?? created[0];
      if (adopted) {
        defaultBranch = adopted.ref.slice("refs/heads/".length);
        await db.update(repositories).set({ defaultBranch, updatedAt: new Date() }).where(eq(repositories.id, repo.id));
      }
    }
    // Keep HEAD pointing at the default branch whenever that ref exists. Bare
    // repos are initialized before the first branch name is known, so HEAD can
    // dangle (clones then fail with "remote HEAD refers to nonexistent ref") —
    // including when the first push happens to match the schema default.
    if (`refs/heads/${defaultBranch}` in allRefs) {
      try { await pexec("git", ["-C", dir, "symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]); } catch { /* sharded repos set HEAD at init */ }
    }

    await processPush({
      db, git, changeRefs, events,
      namespace: job.namespace, repoName: job.repoName, repoId: repo.id,
      defaultBranch, actor, pushedRefs,
    });
  } catch (e) {
    log("warn", "post_push_job_failed", { err: (e as Error).message, ns: job.namespace, repo: job.repoName });
    throw e;
  }
}
