CREATE TABLE "stripe_events" (
	"event_id" varchar(80) PRIMARY KEY NOT NULL,
	"type" varchar(80),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Dedupe any pre-existing duplicate subscription rows (keep the newest per tenant)
-- so the partial unique indexes below can be created without conflict.
DELETE FROM "subscriptions" a USING "subscriptions" b
  WHERE a.org_id IS NOT NULL AND a.org_id = b.org_id AND (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.id < b.id));--> statement-breakpoint
DELETE FROM "subscriptions" a USING "subscriptions" b
  WHERE a.user_id IS NOT NULL AND a.user_id = b.user_id AND (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.id < b.id));--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_org_uniq" ON "subscriptions" USING btree ("org_id") WHERE org_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_uniq" ON "subscriptions" USING btree ("user_id") WHERE user_id is not null;