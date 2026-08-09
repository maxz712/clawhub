import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";

interface BackupRow {
  id: string;
  repoId: string;
  shardId: string;
  manifestKey: string;
  packCount: number;
  bytesUploaded: number;
  createdAt: string;
}

export function registerBackupCommands(program: Command) {
  const g = program.command("backup").description("(admin) S3-backed repo backups");

  g.command("run <repoId>")
    .description("Trigger a backup for a single repo")
    .action(async repoId => {
      const client = new ApiClient();
      const r = await client.request<{
        backupId: string; manifestKey: string; refCount: number; refLogTip: number;
        packCount: number; packBytes: number; full: boolean;
      }>("POST", `/api/v1/admin/repos/${repoId}/backups`, { tokenKind: "user" });
      console.log(chalk.green(`✓ backup ${r.backupId}`));
      console.log(chalk.gray(`  manifest: ${r.manifestKey}`));
      console.log(chalk.gray(`  refs: ${r.refCount}  ref-log tip: ${r.refLogTip}`));
      console.log(chalk.gray(`  objects: ${r.packCount} pack(s), ${r.packBytes ?? 0} bytes (${r.full ? "full" : "incremental"})`));
      // A refs-only backup carries no objects and cannot be restored (#140).
      if (r.refCount > 0 && !r.packCount && r.full) {
        console.log(chalk.yellow("  ! this backup carries no objects and is not restorable"));
      }
    });

  g.command("list <repoId>")
    .description("List backups for a repo")
    .action(async repoId => {
      const client = new ApiClient();
      const r = await client.request<{ backups: BackupRow[] }>(
        "GET", `/api/v1/admin/repos/${repoId}/backups`, { tokenKind: "user" });
      if (!r.backups.length) {
        console.log(chalk.gray("no backups yet"));
        return;
      }
      for (const b of r.backups) {
        console.log(`${b.id}  ${b.createdAt}  packs=${b.packCount}  bytes=${b.bytesUploaded}  ${chalk.gray(b.manifestKey)}`);
      }
    });

  g.command("restore <repoId> <backupId> <toShardId>")
    .description("Restore a backup to a target shard (use 'local' for the unsharded disk tier)")
    .action(async (repoId, backupId, toShardId) => {
      const client = new ApiClient();
      // A partial restore is now a non-2xx (#140), so `request` prints the
      // failure and exits — the ✓ below can only be reached by a restore that
      // applied every pack and wrote every ref.
      const r = await client.request<{ refs: number; restored: number; packsApplied: number }>(
        "POST", `/api/v1/admin/repos/${repoId}/restore`, { body: { backupId, toShardId }, tokenKind: "user" });
      console.log(chalk.green(`✓ restored ${repoId} to ${toShardId}`));
      console.log(chalk.gray(`  refs: ${r.restored}/${r.refs}  packs applied: ${r.packsApplied}`));
    });
}
