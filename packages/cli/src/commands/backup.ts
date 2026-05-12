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
  const g = program.command("backup").description("S3-backed repo backups (admin)");

  g.command("run <repoId>")
    .description("Trigger a backup for a single repo")
    .action(async repoId => {
      const client = new ApiClient();
      const r = await client.request<{ backupId: string; manifestKey: string; refCount: number; refLogTip: number }>(
        "POST", `/api/v1/admin/repos/${repoId}/backups`, { tokenKind: "user" });
      console.log(chalk.green(`✓ backup ${r.backupId}`));
      console.log(chalk.gray(`  manifest: ${r.manifestKey}`));
      console.log(chalk.gray(`  refs: ${r.refCount}  ref-log tip: ${r.refLogTip}`));
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
    .description("Restore a backup to a target shard")
    .action(async (repoId, backupId, toShardId) => {
      const client = new ApiClient();
      await client.request("POST", `/api/v1/admin/repos/${repoId}/restore`, {
        body: { backupId, toShardId }, tokenKind: "user",
      });
      console.log(chalk.green(`✓ restored ${repoId} to ${toShardId}`));
    });
}
