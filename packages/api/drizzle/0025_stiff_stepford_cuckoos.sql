CREATE TABLE "org_merge_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_merge_policy_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
ALTER TABLE "repo_collaborators" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_collaborators" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "org_merge_policy" ADD CONSTRAINT "org_merge_policy_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_collaborators" ADD CONSTRAINT "repo_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_collab_human_uniq" ON "repo_collaborators" USING btree ("repo_id","user_id");