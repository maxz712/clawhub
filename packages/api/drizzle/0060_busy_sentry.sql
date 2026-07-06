ALTER TABLE "agents" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_handle" varchar(120);