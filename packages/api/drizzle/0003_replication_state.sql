ALTER TABLE "repo_shards" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ref_log" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "repo_id" uuid NOT NULL,
  "ref_name" varchar(500) NOT NULL,
  "old_sha" varchar(64) NOT NULL,
  "new_sha" varchar(64) NOT NULL,
  "shard_id" varchar(120) NOT NULL,
  "agent_id" uuid,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ref_log" ADD CONSTRAINT "ref_log_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ref_log_repo_idx" ON "ref_log" USING btree ("repo_id", "id");
--> statement-breakpoint
CREATE INDEX "ref_log_shard_idx" ON "ref_log" USING btree ("shard_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shard_replication_state" (
  "shard_id" varchar(120) NOT NULL,
  "repo_id" uuid NOT NULL,
  "last_seq_applied" bigint DEFAULT 0 NOT NULL,
  "last_applied_at" timestamp with time zone,
  "status" varchar(20) DEFAULT 'healthy' NOT NULL,
  "last_error" text
);
--> statement-breakpoint
ALTER TABLE "shard_replication_state" ADD CONSTRAINT "shard_replication_state_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "shard_replication_state_pk" ON "shard_replication_state" USING btree ("shard_id", "repo_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_migrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL,
  "from_shard_id" varchar(120) NOT NULL,
  "to_shard_id" varchar(120) NOT NULL,
  "state" varchar(20) DEFAULT 'queued' NOT NULL,
  "last_seq_applied" bigint DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_migrations" ADD CONSTRAINT "repo_migrations_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "repo_migrations_repo_idx" ON "repo_migrations" USING btree ("repo_id");
--> statement-breakpoint
CREATE INDEX "repo_migrations_state_idx" ON "repo_migrations" USING btree ("state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL,
  "shard_id" varchar(120) NOT NULL,
  "manifest_key" varchar(1000) NOT NULL,
  "refs_key" varchar(1000) NOT NULL,
  "parent_backup_id" uuid,
  "bytes_uploaded" bigint DEFAULT 0 NOT NULL,
  "pack_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_backups" ADD CONSTRAINT "repo_backups_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "repo_backups_repo_idx" ON "repo_backups" USING btree ("repo_id", "created_at");
