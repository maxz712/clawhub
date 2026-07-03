ALTER TABLE "agents" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "dispatch_model" varchar(64);--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "native_reviewer_enabled" boolean;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "advisory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "contract" jsonb;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;