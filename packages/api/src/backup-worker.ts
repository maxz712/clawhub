import { db } from "./models/db.js";
import { GitClientPool } from "./services/git-client.js";
import { ShardBackupService } from "./services/shard-backup.js";
import { buildObjectStoreFromEnv } from "./services/object-store.js";
import { log } from "./services/logger.js";

const intervalMs = Number(process.env.CLAWHUB_BACKUP_INTERVAL_MS ?? 60 * 60 * 1000); // hourly sweep
const localBase = process.env.CLAWHUB_BACKUP_LOCAL_BASE ?? "./data/backups";

const clients = new GitClientPool();
const store = buildObjectStoreFromEnv(localBase);
const svc = new ShardBackupService(db, clients, store);

let running = true;

async function tick() {
  try {
    const due = await svc.listDueBackups();
    log("info", "backup_tick", { due: due.length });
    for (const repoId of due) {
      try { await svc.backupRepo(repoId); }
      catch (e) { log("warn", "backup_repo_failed", { repoId, err: (e as Error).message }); }
    }
  } catch (e) {
    log("warn", "backup_tick_err", { err: (e as Error).message });
  }
}

function shutdown(signal: string) {
  log("info", "backup_worker_shutdown", { signal });
  running = false;
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function loop() {
  log("info", "backup_worker_started", { intervalMs, pid: process.pid });
  while (running) {
    await tick();
    if (!running) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  process.exit(0);
}

loop().catch(e => {
  log("error", "backup_worker_boot_failed", { err: (e as Error).message });
  process.exit(1);
});
