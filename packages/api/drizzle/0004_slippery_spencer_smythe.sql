-- Snapshot sync only. The sharding tables (git_shards, repo_shards, ref_log,
-- shard_replication_state, repo_migrations, repo_backups) were created by the
-- hand-written 0002_shard_map.sql and 0003_replication_state.sql, which predate
-- their drizzle snapshots. This migration carries the snapshot so future
-- `drizzle-kit generate` runs diff against the real schema. It changes nothing.
SELECT 1;
