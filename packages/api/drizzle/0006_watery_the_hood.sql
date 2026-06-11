CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(40) NOT NULL,
	"provider_user_id" varchar(255) NOT NULL,
	"email" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_uid_uniq" ON "user_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
-- One-time normalization: the register/login/OAuth paths now all lowercase
-- emails; bring existing rows in line so lookups keep matching.
UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");
