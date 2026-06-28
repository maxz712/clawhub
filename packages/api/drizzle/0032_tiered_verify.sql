ALTER TABLE "changes" ADD COLUMN IF NOT EXISTS "verify_tier" varchar(12);--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN IF NOT EXISTS "verify_tier_reason" text;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD COLUMN IF NOT EXISTS "tier" varchar(12);--> statement-breakpoint
ALTER TABLE "verification_runs" ADD COLUMN IF NOT EXISTS "observed_coverage" jsonb DEFAULT '[]'::jsonb NOT NULL;
