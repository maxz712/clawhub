ALTER TABLE "users" ALTER COLUMN "totp_secret" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_nonce" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;