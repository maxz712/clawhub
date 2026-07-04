CREATE TABLE "repo_loops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"autonomy" varchar(16) DEFAULT 'review_only' NOT NULL,
	"developer_role_id" uuid,
	"reviewer_role_id" uuid,
	"triager_role_id" uuid,
	"applied_policy_sha" varchar(64),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_loops_repo_id_unique" UNIQUE("repo_id")
);
--> statement-breakpoint
ALTER TABLE "repo_loops" ADD CONSTRAINT "repo_loops_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_loops" ADD CONSTRAINT "repo_loops_developer_role_id_agent_roles_id_fk" FOREIGN KEY ("developer_role_id") REFERENCES "public"."agent_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_loops" ADD CONSTRAINT "repo_loops_reviewer_role_id_agent_roles_id_fk" FOREIGN KEY ("reviewer_role_id") REFERENCES "public"."agent_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_loops" ADD CONSTRAINT "repo_loops_triager_role_id_agent_roles_id_fk" FOREIGN KEY ("triager_role_id") REFERENCES "public"."agent_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_loops" ADD CONSTRAINT "repo_loops_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;