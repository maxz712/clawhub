ALTER TABLE "ci_pipelines" ADD COLUMN "trigger_kind" varchar(16) DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_pipelines" ADD COLUMN "trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_pipelines" ADD COLUMN "last_scheduled_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "origin" varchar(16);--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "trigger_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "trigger_event" varchar(64);--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "commit" varchar(64);--> statement-breakpoint
CREATE INDEX "ci_pipelines_trigger_idx" ON "ci_pipelines" USING btree ("trigger_kind");--> statement-breakpoint
CREATE INDEX "ci_runs_pipeline_commit_idx" ON "ci_runs" USING btree ("pipeline_id","commit");--> statement-breakpoint
-- Backfill trigger_kind for pre-existing pipelines from their YAML `on:` field.
-- Without this, an existing `on: merge` deploy pipeline would default to 'push'
-- and start running on every Change. Match a top-level `on:` line (anchored at
-- column 0) so a step's `run:` containing the word never false-matches.
UPDATE "ci_pipelines" SET "trigger_kind" = 'merge'
  WHERE "yaml" ~ '(^|\n)on:[ \t]*merge([ \t]|$)';--> statement-breakpoint
UPDATE "ci_pipelines" SET "trigger_kind" = 'schedule'
  WHERE "yaml" ~ '(^|\n)on:[ \t]*schedule([ \t]|$)';--> statement-breakpoint
UPDATE "ci_pipelines" SET "trigger_kind" = 'event'
  WHERE "yaml" ~ '(^|\n)on:[ \t]*event([ \t]|$)';