CREATE TABLE "issue_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"change_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_changes" ADD CONSTRAINT "issue_changes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_changes" ADD CONSTRAINT "issue_changes_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_changes" ADD CONSTRAINT "issue_changes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_changes_issue_idx" ON "issue_changes" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_changes_change_idx" ON "issue_changes" USING btree ("change_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_changes_uniq" ON "issue_changes" USING btree ("issue_id","change_id");