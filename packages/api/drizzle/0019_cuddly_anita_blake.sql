CREATE TYPE "public"."role_capability" AS ENUM('worker', 'reviewer', 'triager', 'specialist');--> statement-breakpoint
CREATE TABLE "agent_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" varchar(8) NOT NULL,
	"owner_id" uuid,
	"name" varchar(120) NOT NULL,
	"slug" varchar(120),
	"description" text,
	"capability" "role_capability" DEFAULT 'worker' NOT NULL,
	"specialization" varchar(64),
	"image" varchar(500) NOT NULL,
	"command" text,
	"mode" varchar(16) DEFAULT 'worker' NOT NULL,
	"trigger" varchar(16) DEFAULT 'manual' NOT NULL,
	"cron" varchar(120),
	"event" varchar(64),
	"interval_sec" integer DEFAULT 3600 NOT NULL,
	"task" text DEFAULT '' NOT NULL,
	"llm_provider" varchar(24) DEFAULT 'anthropic' NOT NULL,
	"llm_base_url" text,
	"agent_id" uuid,
	"llm_ciphertext" text,
	"llm_nonce" varchar(120),
	"token_ciphertext" text,
	"token_nonce" varchar(120),
	"memory_mb" integer DEFAULT 1024 NOT NULL,
	"cpus" integer DEFAULT 1 NOT NULL,
	"timeout_sec" integer DEFAULT 1800 NOT NULL,
	"min_trust_tier" varchar(16) DEFAULT 'sandbox' NOT NULL,
	"earned_autonomy" boolean DEFAULT false NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "standing_agents" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_roles_owner_idx" ON "agent_roles" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_slug_uniq" ON "agent_roles" USING btree ("slug") WHERE slug is not null;--> statement-breakpoint
CREATE INDEX "agent_roles_template_idx" ON "agent_roles" USING btree ("is_template","is_public");--> statement-breakpoint
ALTER TABLE "standing_agents" ADD CONSTRAINT "standing_agents_role_id_agent_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."agent_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standing_agents_role_idx" ON "standing_agents" USING btree ("role_id");