ALTER TABLE "changes" DROP CONSTRAINT "changes_opened_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "gdpr_requests" DROP CONSTRAINT "gdpr_requests_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "gdpr_requests" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gdpr_requests" ADD CONSTRAINT "gdpr_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;