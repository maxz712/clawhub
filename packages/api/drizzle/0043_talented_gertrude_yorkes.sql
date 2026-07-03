ALTER TABLE "verification_runs" ADD COLUMN "spec_basis" varchar(16);--> statement-breakpoint
ALTER TABLE "verification_runs" ADD COLUMN "spec_excerpt" text;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD COLUMN "divergence" jsonb DEFAULT '{"undeclared":[]}'::jsonb NOT NULL;