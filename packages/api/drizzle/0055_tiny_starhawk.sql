ALTER TABLE "ci_runs" ADD COLUMN "priority_class" integer;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "resource_request" jsonb;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "runs_on" varchar(16);--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "assigned_node" varchar(64);--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "effective_priority" integer;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "max_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "terminal_reason" varchar(24);--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "last_heartbeat_at" timestamp with time zone;