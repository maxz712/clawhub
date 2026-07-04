/**
 * Native-reviewer quality audit (M4 · gate D5). Answers "is the advisory
 * reviewer catching real problems at usable precision, and what does it cost?"
 * with a confusion table of COUNTS (not percentages — small-N honesty), per
 * model, plus tokens/review from platform_usage.
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/reviewer-audit.ts [ns/repo] [limit]
 *
 * With no ns/repo it audits the whole instance. Default limit 30 recent Changes
 * that received an advisory review.
 *
 * Confusion table (per model):
 *   flagged→rolled-back   — reviewer flagged concerns AND the change later rolled back (TRUE positive)
 *   approved→rolled-back  — reviewer said looks-good but it rolled back (MISS — the dangerous cell)
 *   flagged→fine          — reviewer flagged but the change merged + stuck (NOISE — the precision cost)
 *   approved→fine         — reviewer approved and it stuck (true negative)
 *   (pending)             — change not yet terminal; excluded from the table
 *
 * Read-only. No LLM. Exit 0 always (a report, not a gate). The D5 gates read
 * these counts: noise (flagged→fine) < ~50% of flags, zero attributable
 * approved→rolled-back misses, blended cost ≤ $0.10/review.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/models/schema.js";
import { changes, platformUsage, reviews, repositories } from "../src/models/schema.js";
import { resolveNamespace } from "../src/services/namespace.js";

const arg = process.argv[2];
const limit = Number(process.argv[3] ?? 30);
const url = process.env.DATABASE_URL ?? "postgresql://clawhub:clawhub@localhost:5432/clawhub";
const sql = postgres(url, { max: 4 });
const db = drizzle(sql, { schema });

type Cell = "flagged_rolledback" | "approved_rolledback" | "flagged_fine" | "approved_fine" | "pending";

function classify(verdict: string, status: string): Cell {
  const flagged = verdict === "request_changes";
  const rolledBack = status === "rolled_back";
  const terminal = status === "merged" || status === "rolled_back";
  if (!terminal) return "pending";
  if (flagged && rolledBack) return "flagged_rolledback";
  if (!flagged && rolledBack) return "approved_rolledback";
  if (flagged && !rolledBack) return "flagged_fine";
  return "approved_fine";
}

async function main() {
  let repoIds: string[] | null = null;
  if (arg) {
    const [nsName, repoName] = arg.split("/");
    const ns = await resolveNamespace(db, nsName);
    if (!ns) { console.error(`namespace not found: ${nsName}`); process.exit(1); }
    const repo = (await db.select({ id: repositories.id }).from(repositories)
      .where(and(eq(repositories.namespaceType, ns.kind), eq(repositories.namespaceId, ns.id), eq(repositories.name, repoName))).limit(1))[0];
    if (!repo) { console.error(`repo not found: ${arg}`); process.exit(1); }
    repoIds = [repo.id];
  }

  // Advisory reviews (latest per change), newest first.
  const advRows = await db.select().from(reviews).where(and(eq(reviews.advisory, true), isNull(reviews.supersededAt))).orderBy(desc(reviews.submittedAt)).limit(limit * 4);
  const byChange = new Map<string, typeof advRows[number]>();
  for (const r of advRows) if (!byChange.has(r.changeId)) byChange.set(r.changeId, r);

  const changeIds = [...byChange.keys()];
  if (!changeIds.length) { console.log("No advisory reviews found yet."); await sql.end(); return; }
  const changeRows = await db.select().from(changes).where(inArray(changes.id, changeIds));
  const changeById = new Map(changeRows.map(c => [c.id, c]));

  // Per-model confusion counts.
  const table: Record<string, Record<Cell, number>> = {};
  const bump = (model: string, cell: Cell) => {
    (table[model] ??= { flagged_rolledback: 0, approved_rolledback: 0, flagged_fine: 0, approved_fine: 0, pending: 0 })[cell]++;
  };
  let considered = 0;
  for (const [changeId, review] of byChange) {
    const ch = changeById.get(changeId);
    if (!ch) continue;
    if (repoIds && !repoIds.includes(ch.repoId)) continue;
    if (considered >= limit) break;
    considered++;
    const model = ((review.contract as { model?: string } | null)?.model) ?? "unknown";
    bump(model, classify(review.verdict, ch.status));
  }

  // Tokens + cost per review run (platform_usage rows attributed to the reviewed changes).
  const usage = changeIds.length ? await db.select().from(platformUsage).where(inArray(platformUsage.changeId, changeIds)) : [];
  const totalMicroUsd = usage.reduce((n, u) => n + (u.costMicroUsd ?? 0), 0);
  const totalIn = usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0);
  const totalOut = usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0);

  console.log(`\n=== Native reviewer audit ${arg ? `· ${arg}` : "· (whole instance)"} · ${considered} change(s) ===\n`);
  for (const [model, cells] of Object.entries(table)) {
    const flags = cells.flagged_rolledback + cells.flagged_fine;
    console.log(`Model: ${model}`);
    console.log(`  flagged → rolled-back (true positive) : ${cells.flagged_rolledback}`);
    console.log(`  approved → rolled-back (MISS)         : ${cells.approved_rolledback}`);
    console.log(`  flagged → fine (noise)                : ${cells.flagged_fine}`);
    console.log(`  approved → fine (true negative)       : ${cells.approved_fine}`);
    console.log(`  pending (not terminal)                : ${cells.pending}`);
    console.log(`  → noise share of flags                : ${flags ? `${cells.flagged_fine}/${flags}` : "n/a"}`);
    console.log("");
  }
  const perReview = usage.length ? (totalMicroUsd / usage.length / 1_000_000) : 0;
  console.log(`Cost: ${usage.length} usage row(s), $${(totalMicroUsd / 1_000_000).toFixed(4)} total, ~$${perReview.toFixed(4)}/review`);
  console.log(`Tokens: ${totalIn} in / ${totalOut} out`);
  console.log(`\nGate reminders (D5): noise < ~50% of flags · zero attributable approved→rolled-back · blended ≤ $0.10/review.\n`);
  await sql.end();
}

main().catch(async e => { console.error(e); await sql.end(); process.exit(1); });
