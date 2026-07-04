CREATE TABLE "platform_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"monthly_cap_micro_usd" bigint DEFAULT 0 NOT NULL,
	"on_exhaust" varchar(16) DEFAULT 'byo_fallback' NOT NULL,
	"alert_at_percent" integer DEFAULT 80 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_budgets" ADD CONSTRAINT "platform_budgets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_budgets" ADD CONSTRAINT "platform_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_budgets_org_idx" ON "platform_budgets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "platform_budgets_user_idx" ON "platform_budgets" USING btree ("user_id");