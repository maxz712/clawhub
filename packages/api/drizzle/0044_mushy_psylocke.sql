CREATE TABLE "verify_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"change_id" uuid NOT NULL,
	"standing_agent_id" uuid,
	"agent_id" uuid NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"check_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changed_paths_hash" varchar(64) NOT NULL,
	"spec_hash" varchar(64) NOT NULL,
	"tier" varchar(12),
	"failure_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verify_plans" ADD CONSTRAINT "verify_plans_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_plans" ADD CONSTRAINT "verify_plans_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_plans" ADD CONSTRAINT "verify_plans_standing_agent_id_standing_agents_id_fk" FOREIGN KEY ("standing_agent_id") REFERENCES "public"."standing_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_plans" ADD CONSTRAINT "verify_plans_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verify_plans_active_uniq" ON "verify_plans" USING btree ("change_id") WHERE active = true;--> statement-breakpoint
CREATE INDEX "verify_plans_change_idx" ON "verify_plans" USING btree ("change_id");