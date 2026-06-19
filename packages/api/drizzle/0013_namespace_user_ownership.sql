CREATE TYPE "public"."user_kind" AS ENUM('human', 'service');--> statement-breakpoint
ALTER TYPE "public"."namespace_type" ADD VALUE 'user';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "service_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" "user_kind" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_service_user_id_users_id_fk" FOREIGN KEY ("service_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;