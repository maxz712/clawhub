CREATE TYPE "public"."memory_kind" AS ENUM('episode', 'convention', 'failure', 'decision', 'expertise');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('agent', 'repo', 'agent_repo', 'org');--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"scope_key" varchar(160) NOT NULL,
	"agent_id" uuid,
	"repo_id" uuid,
	"org_id" uuid,
	"kind" "memory_kind" NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"importance" integer DEFAULT 3 NOT NULL,
	"confidence" integer DEFAULT 50 NOT NULL,
	"trigrams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" text,
	"embedding_model" varchar(80),
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"supersedes_id" uuid,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"source_run_id" uuid,
	"created_by_agent_id" uuid,
	"quarantined_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_run_id_ci_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memories_scope_kind_idx" ON "agent_memories" USING btree ("scope_key","kind","importance");--> statement-breakpoint
CREATE INDEX "agent_memories_fingerprint_idx" ON "agent_memories" USING btree ("repo_id") WHERE facts ->> 'errorFingerprint' is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_run_kind_title_uniq" ON "agent_memories" USING btree ("source_run_id","kind","title") WHERE source_run_id is not null;--> statement-breakpoint
CREATE INDEX "agent_memories_decay_idx" ON "agent_memories" USING btree ("scope_key","last_used_at") WHERE valid_to is null and archived_at is null and pinned = false;--> statement-breakpoint
CREATE INDEX "agent_memories_supersedes_idx" ON "agent_memories" USING btree ("supersedes_id");