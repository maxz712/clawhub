ALTER TABLE "standing_agents" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_agents" ADD COLUMN "next_eligible_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ci_runs_standing_pending_uniq" ON "ci_runs" USING btree ("standing_agent_id") WHERE status = 'pending' and standing_agent_id is not null;