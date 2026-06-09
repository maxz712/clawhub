CREATE INDEX "changes_status_idx" ON "changes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "changes_created_idx" ON "changes" USING btree ("created_at");