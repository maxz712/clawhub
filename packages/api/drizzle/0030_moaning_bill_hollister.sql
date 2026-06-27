CREATE TABLE "verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"change_id" uuid NOT NULL,
	"ci_run_id" uuid,
	"standing_agent_id" uuid,
	"agent_id" uuid NOT NULL,
	"head_commit" varchar(64) NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "cli" varchar(16) DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD COLUMN "cli" varchar(16) DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_ci_run_id_ci_runs_id_fk" FOREIGN KEY ("ci_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_standing_agent_id_standing_agents_id_fk" FOREIGN KEY ("standing_agent_id") REFERENCES "public"."standing_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_runs_change_head_uniq" ON "verification_runs" USING btree ("change_id","head_commit");--> statement-breakpoint
CREATE INDEX "verification_runs_change_idx" ON "verification_runs" USING btree ("change_id");