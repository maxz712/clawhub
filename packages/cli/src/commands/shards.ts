import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";

interface ShardRow {
  id: string;
  endpoint: string;
  role: string;
  status: string;
  leaseHolder?: string | null;
  leaseExpiresAt?: string | null;
}

interface PlacementRow {
  repoId: string;
  primaryShardId: string;
  replicaShardIds: string[];
  status: string;
}

interface ReplicationRow {
  shardId: string;
  repoId: string;
  lastSeqApplied: number;
  status: string;
}

export function registerShardCommands(program: Command) {
  const g = program.command("shards").description("(admin) Manage git-service shards");

  g.command("list")
    .description("List configured shards")
    .action(async () => {
      const client = new ApiClient();
      const r = await client.request<{ shards: ShardRow[] }>("GET", "/api/v1/admin/shards", { tokenKind: "user" });
      if (!r.shards.length) {
        console.log(chalk.gray("no shards configured — repos run on the local in-process backend"));
        return;
      }
      for (const s of r.shards) {
        console.log(`${chalk.bold(s.id)}  ${s.endpoint}  ${tag(s.role)}  ${health(s.status)}`);
        if (s.leaseHolder) console.log(chalk.gray(`  lease: ${s.leaseHolder} until ${s.leaseExpiresAt ?? "?"}`));
      }
    });

  g.command("add <id> <endpoint>")
    .description("Register a new shard")
    .option("--role <role>", "primary | replica", "primary")
    .action(async (id, endpoint, opts) => {
      const client = new ApiClient();
      await client.request("POST", "/api/v1/admin/shards", { body: { id, endpoint, role: opts.role }, tokenKind: "user" });
      console.log(chalk.green(`✓ shard ${id} added`));
    });

  g.command("remove <id>")
    .description("Remove a shard from the catalog (no repos must remain on it)")
    .action(async id => {
      const client = new ApiClient();
      await client.request("DELETE", `/api/v1/admin/shards/${id}`, { tokenKind: "user" });
      console.log(chalk.green(`✓ shard ${id} removed`));
    });

  g.command("place <repoId> [shardId]")
    .description("Place a repo on a shard (default: HRW pick)")
    .action(async (repoId, shardId) => {
      const client = new ApiClient();
      if (shardId) {
        const r = await client.request<{ id: string }>("POST", `/api/v1/admin/shards/migrate/${repoId}`, { body: { toShardId: shardId }, tokenKind: "user" });
        console.log(chalk.green(`✓ migration ${r.id} enqueued`));
      } else {
        const r = await client.request<{ shard: { id: string } }>("POST", `/api/v1/admin/shards/place/${repoId}`, { tokenKind: "user" });
        console.log(chalk.green(`✓ placed on ${r.shard.id}`));
      }
    });

  g.command("status")
    .description("Show per-shard health + repo counts")
    .action(async () => {
      const client = new ApiClient();
      const [{ shards }, { placements }] = await Promise.all([
        client.request<{ shards: ShardRow[] }>("GET", "/api/v1/admin/shards", { tokenKind: "user" }),
        client.request<{ placements: PlacementRow[] }>("GET", "/api/v1/admin/shards/placements", { tokenKind: "user" }),
      ]);
      const counts = new Map<string, number>();
      for (const p of placements) counts.set(p.primaryShardId, (counts.get(p.primaryShardId) ?? 0) + 1);

      const header = `${"ID".padEnd(20)}${"STATUS".padEnd(12)}${"ROLE".padEnd(10)}${"REPOS".padEnd(7)}ENDPOINT`;
      console.log(chalk.bold(header));
      for (const s of shards) {
        const n = counts.get(s.id) ?? 0;
        // Pad the plain status first, then colorize — padEnd counts the ANSI
        // escape bytes as characters, so coloring before padding misaligns.
        console.log(`${s.id.padEnd(20)}${healthPadded(s.status, 12)}${s.role.padEnd(10)}${String(n).padEnd(7)}${s.endpoint}`);
      }
    });

  g.command("drain <id>")
    .description("Stop placing new repos on a shard and migrate existing ones away")
    .action(async id => {
      const client = new ApiClient();
      const r = await client.request<{ enqueued: Array<{ repoId: string; migrationId: string }>; total: number }>(
        "POST", `/api/v1/admin/shards/${id}/drain`, { tokenKind: "user" });
      console.log(chalk.green(`✓ ${id} draining: enqueued ${r.enqueued.length} of ${r.total} migrations`));
    });

  g.command("promote <repoId> <toShardId>")
    .description("Force-promote a caught-up replica to primary for a repo")
    .action(async (repoId, toShardId) => {
      const client = new ApiClient();
      await client.request("POST", `/api/v1/admin/shards/promote/${repoId}`, { body: { toShardId }, tokenKind: "user" });
      console.log(chalk.green(`✓ ${repoId} now primary on ${toShardId}`));
    });

  g.command("lag <id>")
    .description("Show replication lag rows for a replica shard")
    .action(async id => {
      const client = new ApiClient();
      const r = await client.request<{ replication: ReplicationRow[] }>(
        "GET", `/api/v1/admin/shards/${id}/replication-lag`, { tokenKind: "user" });
      if (!r.replication.length) {
        console.log(chalk.gray("no replication rows on this shard"));
        return;
      }
      for (const row of r.replication) {
        console.log(`${row.repoId}  seq=${row.lastSeqApplied}  ${health(row.status)}`);
      }
    });

  g.command("reap-leases")
    .description("Reap stale shard leases (operator escape hatch)")
    .action(async () => {
      const client = new ApiClient();
      const r = await client.request<{ reaped: number }>("POST", "/api/v1/admin/shards/reap-leases", { tokenKind: "user" });
      console.log(chalk.green(`✓ reaped ${r.reaped} lease rows`));
    });
}

function tag(s: string): string {
  return s === "primary" ? chalk.cyan(s) : chalk.gray(s);
}
function healthColor(s: string): (text: string) => string {
  if (s === "healthy" || s === "active") return chalk.green;
  if (s === "unhealthy" || s === "degraded" || s === "read_only" || s === "failed") return chalk.red;
  if (s === "draining" || s === "migrating" || s === "lagging") return chalk.yellow;
  return chalk.gray;
}
function health(s: string): string {
  return healthColor(s)(s);
}
// Pad to a column width on the PLAIN string, then color — so ANSI escape
// bytes don't count toward the width and the column stays aligned.
function healthPadded(s: string, width: number): string {
  return healthColor(s)(s.padEnd(width));
}
