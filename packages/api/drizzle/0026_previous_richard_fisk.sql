ALTER TABLE "changes" ALTER COLUMN "opened_by_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "opened_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "public_activity" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_activity" ADD CONSTRAINT "public_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;