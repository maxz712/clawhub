ALTER TABLE "changes" ADD COLUMN "on_behalf_of_user_id" uuid;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD COLUMN "exec_style" varchar(8) DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;