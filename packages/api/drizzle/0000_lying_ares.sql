CREATE TYPE "public"."agent_type" AS ENUM('openclaw', 'claude_code', 'cursor', 'generic');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('github_oauth', 'email', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."change_status" AS ENUM('pending', 'approved', 'rejected', 'merged', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."rule_type" AS ENUM('allow_path', 'deny_path', 'require_approval', 'auto_merge');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "agent_type" DEFAULT 'generic' NOT NULL,
	"owner_id" uuid NOT NULL,
	"public_key" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid,
	"agent_id" uuid,
	"action" varchar(255) NOT NULL,
	"metadata" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"agent_id" uuid,
	"intent" text NOT NULL,
	"description" text,
	"status" "change_status" DEFAULT 'pending' NOT NULL,
	"risk_level" "risk_level" DEFAULT 'low' NOT NULL,
	"branch" varchar(255) NOT NULL,
	"diff_summary" jsonb,
	"semantic_diff" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "permission_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"agent_id" uuid,
	"rule_type" "rule_type" NOT NULL,
	"pattern" text NOT NULL,
	"conditions" jsonb
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"owner_id" uuid NOT NULL,
	"git_path" text NOT NULL,
	"description" text,
	"default_branch" varchar(255) DEFAULT 'main' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"auth_provider" "auth_provider" DEFAULT 'email' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_owner_id_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "audit_repo_id_idx" ON "audit_events" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "audit_agent_id_idx" ON "audit_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "audit_timestamp_idx" ON "audit_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "changes_repo_id_idx" ON "changes" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "changes_agent_id_idx" ON "changes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "changes_status_idx" ON "changes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "perm_rules_repo_id_idx" ON "permission_rules" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "repos_owner_id_idx" ON "repositories" USING btree ("owner_id");