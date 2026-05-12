CREATE TABLE IF NOT EXISTS "git_shards" (
  "id" varchar(120) PRIMARY KEY NOT NULL,
  "endpoint" varchar(500) NOT NULL,
  "role" varchar(20) DEFAULT 'primary' NOT NULL,
  "status" varchar(20) DEFAULT 'healthy' NOT NULL,
  "lease_holder" varchar(200),
  "lease_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_shards" (
  "repo_id" uuid PRIMARY KEY NOT NULL,
  "primary_shard_id" varchar(120) NOT NULL,
  "replica_shard_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_shards" ADD CONSTRAINT "repo_shards_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repo_shards" ADD CONSTRAINT "repo_shards_primary_shard_id_git_shards_id_fk" FOREIGN KEY ("primary_shard_id") REFERENCES "public"."git_shards"("id") ON DELETE restrict ON UPDATE no action;
