ALTER TABLE "gdpr_requests" ADD COLUMN "token_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "gdpr_requests" ADD COLUMN "expires_at" timestamp with time zone;