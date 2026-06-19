CREATE TABLE "standing_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"image" varchar(500) NOT NULL,
	"command" text,
	"trigger" varchar(16) DEFAULT 'manual' NOT NULL,
	"cron" varchar(120),
	"event" varchar(64),
	"interval_sec" integer DEFAULT 300 NOT NULL,
	"task" text DEFAULT '' NOT NULL,
	"llm_provider" varchar(24) DEFAULT 'anthropic' NOT NULL,
	"llm_base_url" text,
	"llm_ciphertext" text,
	"llm_nonce" varchar(120),
	"token_ciphertext" text NOT NULL,
	"token_nonce" varchar(120) NOT NULL,
	"memory_mb" integer DEFAULT 1024 NOT NULL,
	"cpus" integer DEFAULT 1 NOT NULL,
	"timeout_sec" integer DEFAULT 1800 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" varchar(16) DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"last_run_id" uuid,
	"last_run_at" timestamp with time zone,
	"last_scheduled_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ci_runs" ALTER COLUMN "pipeline_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "standing_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD CONSTRAINT "standing_agents_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD CONSTRAINT "standing_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD CONSTRAINT "standing_agents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standing_agents_uniq" ON "standing_agents" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX "standing_agents_repo_idx" ON "standing_agents" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "standing_agents_trigger_idx" ON "standing_agents" USING btree ("trigger");--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_standing_agent_id_standing_agents_id_fk" FOREIGN KEY ("standing_agent_id") REFERENCES "public"."standing_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_runs_standing_idx" ON "ci_runs" USING btree ("standing_agent_id");