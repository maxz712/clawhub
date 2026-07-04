CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" varchar(32) NOT NULL,
	"account_login" varchar(120) NOT NULL,
	"account_type" varchar(24) DEFAULT 'User' NOT NULL,
	"account_id" varchar(32),
	"repo_selection" varchar(24) DEFAULT 'selected' NOT NULL,
	"owner_user_id" uuid,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_pr_mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" varchar(32) NOT NULL,
	"owner" varchar(120) NOT NULL,
	"repo" varchar(120) NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" varchar(64) NOT NULL,
	"head_ref" varchar(255),
	"base_ref" varchar(255),
	"clone_url" text,
	"mirror_repo_id" uuid,
	"change_id" uuid,
	"check_run_id" varchar(32),
	"state" varchar(24) DEFAULT 'received' NOT NULL,
	"last_error" text,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"label" varchar(120) NOT NULL,
	"agent_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pr_mirrors" ADD CONSTRAINT "github_pr_mirrors_mirror_repo_id_repositories_id_fk" FOREIGN KEY ("mirror_repo_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pr_mirrors" ADD CONSTRAINT "github_pr_mirrors_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_routing_rules" ADD CONSTRAINT "issue_routing_rules_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_routing_rules" ADD CONSTRAINT "issue_routing_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_pr_mirrors_pr_uniq" ON "github_pr_mirrors" USING btree ("owner","repo","pr_number");--> statement-breakpoint
CREATE INDEX "github_pr_mirrors_change_idx" ON "github_pr_mirrors" USING btree ("change_id");--> statement-breakpoint
CREATE INDEX "issue_routing_repo_idx" ON "issue_routing_rules" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_routing_repo_label_uniq" ON "issue_routing_rules" USING btree ("repo_id","label");