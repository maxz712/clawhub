CREATE TABLE "access_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '{"push":true,"review":true}'::jsonb NOT NULL,
	"repo_scope" varchar(16) DEFAULT 'all' NOT NULL,
	"repo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"provider" varchar(40) DEFAULT 'anthropic' NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "llm_key_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "access_role_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD COLUMN "llm_key_id" uuid;--> statement-breakpoint
ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_keys" ADD CONSTRAINT "llm_keys_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_roles_owner_idx" ON "access_roles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "llm_keys_owner_idx" ON "llm_keys" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_llm_key_id_llm_keys_id_fk" FOREIGN KEY ("llm_key_id") REFERENCES "public"."llm_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD CONSTRAINT "standing_agents_llm_key_id_llm_keys_id_fk" FOREIGN KEY ("llm_key_id") REFERENCES "public"."llm_keys"("id") ON DELETE set null ON UPDATE no action;