CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"standing_agent_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"trigger" varchar(16) DEFAULT 'manual' NOT NULL,
	"cron" varchar(120),
	"event" varchar(64),
	"interval_sec" integer DEFAULT 3600 NOT NULL,
	"repo_scope" varchar(16) DEFAULT 'all' NOT NULL,
	"repo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_scheduled_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "standing_agents" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_standing_agent_id_standing_agents_id_fk" FOREIGN KEY ("standing_agent_id") REFERENCES "public"."standing_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflows_deployment_idx" ON "workflows" USING btree ("standing_agent_id");--> statement-breakpoint
CREATE INDEX "workflows_trigger_idx" ON "workflows" USING btree ("trigger");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standing_agents_global_agent_uniq" ON "standing_agents" USING btree ("agent_id") WHERE repo_id IS NULL;