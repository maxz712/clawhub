// Server-authored Change primitive (N5). ClawHub itself — the API process, no
// container, no LLM — authors a commit and opens a real Change under the normal
// merge policy. The system never MERGES it (a human/agent still owns the gate);
// it only proposes. First use: the AGENTS.md auto-sync PR, so a repo's canonical
// ClawHub trailer docs stay current without a human hand-editing them.
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, repositories, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { ChangeRefService } from "./change-refs.js";
import type { EventBus } from "./events.js";
import { processPush } from "./post-push.js";
import { namespaceNameOf } from "./namespace.js";
import { hashToken, randomToken } from "./auth.js";
import { agentsMdBlock, AGENTS_MD_BEGIN, AGENTS_MD_END } from "./agents-md.js";
import { log } from "./logger.js";

const SYSTEM_USER = "clawhub-system";
export const SYSTEM_USER_EMAIL = "svc-clawhub-system@clawhub.invalid";

/**
 * Find-or-create the `clawhub-system` service user that authors server Changes.
 * Pinned to its own email for the same reason as `ensureGhMirrorUser` (#139) —
 * adopting a same-named service row would let whoever owns that row author
 * commits attributed to "ClawHub system".
 */
export async function ensureSystemUser(db: DB): Promise<string> {
  const existing = (await db.select().from(users).where(eq(users.username, SYSTEM_USER)).limit(1))[0];
  if (existing) {
    if (existing.kind !== "service") throw new Error(`cannot provision ${SYSTEM_USER}: username taken by a human`);
    if (existing.email !== SYSTEM_USER_EMAIL) throw new Error(`refusing to reuse ${SYSTEM_USER}: the namespace is held by another identity`);
    return existing.id;
  }
  const inserted = (await db.insert(users).values({
    email: SYSTEM_USER_EMAIL,
    username: SYSTEM_USER,
    name: "ClawHub system",
    kind: "service",
    passwordHash: await hashToken(randomToken(24)),
  }).returning())[0];
  return inserted.id;
}

export interface ServerChangeInput {
  db: DB;
  git: GitService;
  changeRefs: ChangeRefService;
  events: EventBus;
  repoId: string;
  branch: string;
  files: Array<{ path: string; content: string }>;
  intent: string;
  risk?: "low" | "medium" | "high" | "critical";
  reviewFocus?: string;
  body?: string; // commit body prose (becomes changes.description)
}

/**
 * Author a commit on `branch` off the repo's default branch with the given file
 * contents, then open a Change for it via the normal post-push pipeline. Returns
 * the changeId (+ commit). No-ops to `{ changed: false }` if the resulting tree
 * is identical to the base (nothing to propose).
 */
export async function openServerChange(input: ServerChangeInput): Promise<{ changed: boolean; changeId?: string; commit?: string; branch: string }> {
  const { db, git, changeRefs, events, repoId, branch, files, intent } = input;
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (!repo) throw new Error("repo not found");
  const ns = await namespaceNameOf(db, repo.namespaceType, repo.namespaceId);
  if (!ns) throw new Error("namespace not resolvable");
  const baseBranch = repo.defaultBranch;

  const baseSha = await git.headCommit(ns, repo.name, baseBranch).catch(() => "");
  if (!baseSha) throw new Error("repo has no default-branch head to base on");

  // Skip if every file already matches the base (nothing to propose).
  const current = await git.filesAt(ns, repo.name, baseSha, files.map(f => f.path));
  const anyDifferent = files.some(f => (current.get(f.path) ?? null) !== f.content);
  if (!anyDifferent) return { changed: false, branch };

  const userId = await ensureSystemUser(db);
  const risk = input.risk ?? "low";
  const trailers = [
    `Intent: ${intent}`,
    `Risk: ${risk}`,
    `Agent: ${SYSTEM_USER}`,
    ...(input.reviewFocus ? [`Review-Focus: ${input.reviewFocus}`] : []),
  ].join("\n");
  const message = `${intent}\n\n${input.body ? input.body + "\n\n" : ""}${trailers}`;

  const commit = await git.commitBlobs(ns, repo.name, baseBranch, branch, files, {
    authorName: "ClawHub system", authorEmail: "system@useclawhub.com", message, expectBaseSha: baseSha,
  });

  await processPush({
    db, git, changeRefs, events,
    namespace: ns, repoName: repo.name, repoId, defaultBranch: baseBranch,
    actor: { kind: "user", userId },
    pushedRefs: [{ ref: `refs/heads/${branch}`, oldSha: "0".repeat(40), newSha: commit }],
  });

  const change = (await db.select({ id: changes.id }).from(changes)
    .where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1))[0];
  log("info", "server_change_opened", { repoId, branch, changeId: change?.id, commit });
  return { changed: true, changeId: change?.id, commit, branch };
}

/** Splice ClawHub's canonical AGENTS.md block into (or update it within) an existing file. */
export function mergeAgentsMdBlock(existing: string | null): string {
  const block = agentsMdBlock();
  if (!existing) return block + "\n";
  const begin = existing.indexOf(AGENTS_MD_BEGIN);
  const end = existing.indexOf(AGENTS_MD_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    // Replace the existing managed block in place.
    return existing.slice(0, begin) + block + existing.slice(end + AGENTS_MD_END.length);
  }
  // Append the block, separated by a blank line.
  return existing.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

/**
 * Open (or refresh) a Change that syncs the repo's AGENTS.md with ClawHub's
 * canonical trailer-convention block. No-op when already current. This is the
 * server-authored-Change primitive's flagship use — distribution (M2) that keeps
 * working after the initial `ch init`.
 */
export async function syncAgentsMdChange(deps: { db: DB; git: GitService; changeRefs: ChangeRefService; events: EventBus }, repoId: string): Promise<{ changed: boolean; changeId?: string }> {
  const { db, git, changeRefs, events } = deps;
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (!repo) throw new Error("repo not found");
  const ns = await namespaceNameOf(db, repo.namespaceType, repo.namespaceId);
  if (!ns) throw new Error("namespace not resolvable");
  const baseSha = await git.headCommit(ns, repo.name, repo.defaultBranch).catch(() => "");
  if (!baseSha) throw new Error("repo has no default-branch head");
  const existing = await git.fileAt(ns, repo.name, baseSha, "AGENTS.md");
  const next = mergeAgentsMdBlock(existing);
  if (existing === next) return { changed: false };
  return openServerChange({
    db, git, changeRefs, events, repoId,
    branch: "clawhub/agents-md-sync",
    files: [{ path: "AGENTS.md", content: next }],
    intent: "Sync the ClawHub AGENTS.md section",
    risk: "low",
    reviewFocus: "AGENTS.md — the canonical ClawHub trailer-convention block",
    body: "ClawHub keeps this managed block (between the clawhub:begin/end markers) current so foreign agents learn the trailer convention repo-side. Authored by the ClawHub system; a human still owns the merge.",
  });
}
