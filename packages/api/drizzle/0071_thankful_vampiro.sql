ALTER TABLE "email_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("status","next_attempt_at");