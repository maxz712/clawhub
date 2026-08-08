ALTER TABLE "issue_changes" ADD COLUMN "closes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- #137 backfill. Before this migration a `Closes: #N` link and a manual link
-- were indistinguishable rows. issues.closing_change_id WAS the trailer's
-- (clobberable) pointer, so it identifies the most recent trailer claimant per
-- issue — the only recoverable signal. Marking those rows keeps in-flight
-- Changes auto-closing across the deploy. Claims an earlier clobber already
-- overwrote are unrecoverable by construction; that is the bug being fixed.
UPDATE "issue_changes" ic SET "closes" = true
FROM "issues" i
WHERE i."id" = ic."issue_id" AND i."closing_change_id" = ic."change_id";
