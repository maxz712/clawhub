-- Per-standing-agent model override (→ CLAWHUB_MODEL → the CLI's --model flag).
-- NOTE: db:generate also diffed verify_tier/verify_tier_reason/tier/observed_coverage
-- as "new" because the hand-written 0032 migration never recorded a schema snapshot —
-- but those columns already exist on prod (0032 added them IF NOT EXISTS), so re-adding
-- them here would fail "column already exists" and break the deploy. This migration
-- adds ONLY the genuinely-new column; the regenerated 0033 snapshot reconciles the meta
-- so future diffs are clean.
ALTER TABLE "standing_agents" ADD COLUMN IF NOT EXISTS "model" varchar(64);
