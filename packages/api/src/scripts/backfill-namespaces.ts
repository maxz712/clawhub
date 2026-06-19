import { and, eq, isNull } from "drizzle-orm";
import { db, pg } from "../models/db.js";
import { agents, repoCollaborators, repositories, users } from "../models/schema.js";
import { deriveUniqueUsername } from "../services/namespace.js";
import { ensureServiceUserForAgent } from "../services/auto-repo.js";

/**
 * One-time, idempotent backfill for the repo-ownership inversion. Safe to re-run.
 *
 *   node dist/scripts/backfill-namespaces.js [--usernames-only] [--agent <name>] [--dry-run]
 *
 *   --usernames-only   only derive handles for human users (Phase 2).
 *   --agent <name>     in Phase 2, only migrate this one agent's repos.
 *   --dry-run          print what would change without writing.
 *
 * Phase 1 (always): give every human user a unique `username` handle.
 * Phase 2 (default): for each agent that owns repos, provision a same-named
 *   service-account user, flip those repos `agent` -> `user` IN PLACE (the
 *   namespace NAME is unchanged, so the on-disk path is unchanged), and grant
 *   the agent `writer`. Repos a human is taking over directly (their own handle)
 *   are migrated by `ch repo transfer`, not here — exclude those agents with
 *   --usernames-only + explicit transfers, or just don't pass them to --agent.
 */
const argv = process.argv.slice(2);
const usernamesOnly = argv.includes("--usernames-only");
const dryRun = argv.includes("--dry-run");
const agentFilter = (() => { const i = argv.indexOf("--agent"); return i >= 0 ? argv[i + 1] : null; })();

async function main() {
  // --- Phase 1: usernames for human users that lack one ---
  const humans = await db.select().from(users).where(and(isNull(users.username), eq(users.kind, "human")));
  console.log(`[backfill] phase 1: ${humans.length} human user(s) need a handle`);
  for (const u of humans) {
    const handle = await deriveUniqueUsername(db, u.email);
    if (dryRun) { console.log(`  would set ${u.email} -> @${handle}`); continue; }
    await db.update(users).set({ username: handle }).where(eq(users.id, u.id));
    console.log(`  ${u.email} -> @${handle}`);
  }

  if (usernamesOnly) { console.log("[backfill] --usernames-only: done"); return; }

  // --- Phase 2: service-account owners for agent-owned repos ---
  const owners = await db.selectDistinct({ id: repositories.namespaceId }).from(repositories)
    .where(eq(repositories.namespaceType, "agent"));
  console.log(`[backfill] phase 2: ${owners.length} agent namespace(s) own repos`);
  for (const { id: agentId } of owners) {
    const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
    if (!agent) continue;
    if (agentFilter && agent.name !== agentFilter) continue;

    const repos = await db.select().from(repositories)
      .where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, agentId)));
    if (dryRun) {
      console.log(`  would migrate ${repos.length} repo(s) of agent ${agent.name} -> service user @${agent.name}`);
      continue;
    }

    // Provision (or reuse) the service user; flip ownership + grant in one txn.
    const serviceUserId = await ensureServiceUserForAgent(db, agent);
    await db.transaction(async tx => {
      await tx.update(repositories)
        .set({ namespaceType: "user", namespaceId: serviceUserId })
        .where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, agentId)));
      for (const r of repos) {
        await tx.insert(repoCollaborators).values({ repoId: r.id, agentId, role: "writer" }).onConflictDoNothing();
      }
    });
    console.log(`  agent ${agent.name}: ${repos.length} repo(s) -> service user @${agent.name} (granted writer)`);
  }
}

try {
  await main();
  console.log("[backfill] done");
} finally {
  await pg.end();
}
