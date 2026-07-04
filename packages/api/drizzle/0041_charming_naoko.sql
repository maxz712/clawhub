CREATE TABLE "platform_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"change_id" uuid,
	"repo_id" uuid,
	"org_id" uuid,
	"user_id" uuid,
	"agent_id" uuid,
	"model" varchar(120) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"billed_sku" varchar(40),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripe_reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "key_source" varchar(16) DEFAULT 'byo' NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "gateway_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "standing_agents" ADD COLUMN "key_source" varchar(16) DEFAULT 'byo' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_usage" ADD CONSTRAINT "platform_usage_run_id_ci_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ci_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_usage" ADD CONSTRAINT "platform_usage_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_usage" ADD CONSTRAINT "platform_usage_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_usage" ADD CONSTRAINT "platform_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_usage" ADD CONSTRAINT "platform_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_usage" ADD CONSTRAINT "platform_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_usage_repo_idx" ON "platform_usage" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_usage_org_idx" ON "platform_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_usage_user_idx" ON "platform_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_usage_unbilled_idx" ON "platform_usage" USING btree ("created_at") WHERE "platform_usage"."stripe_reported_at" is null;