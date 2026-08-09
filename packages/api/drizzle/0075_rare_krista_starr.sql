-- #139: a service-account user belongs to EXACTLY ONE agent, and no agent may
-- hold a PLATFORM namespace (`gh-mirror`, `clawhub-system`).
--
-- Remediation first, constraint second: an instance where the takeover already
-- happened must be cleaned before the unique index below can be created.

-- 1. Revoke any agent's claim on a platform-owned service namespace. No
--    legitimate agent ever holds one — `gh-mirror` is provisioned by
--    ensureGhMirrorUser and `clawhub-system` by ensureSystemUser, neither of
--    which mints an agent. Nulling the back-pointer removes that agent's
--    `write` on those repos (services/repo-access.ts) without touching the
--    repos, which reference the USER row, not the agent.
UPDATE "agents" SET "service_user_id" = NULL
WHERE "service_user_id" IN (
  SELECT "id" FROM "users" WHERE "kind" = 'service' AND "username" IN ('gh-mirror', 'clawhub-system')
);
--> statement-breakpoint
-- 2. De-duplicate any remaining many-agents-to-one-service-user rows, keeping
--    the agent that PROVABLY owns the service user (its `svc-<agent id>@…`
--    email — the same proof ensureServiceUserForAgent now requires), falling
--    back to the oldest agent when no email matches.
UPDATE "agents" a SET "service_user_id" = NULL
WHERE a."service_user_id" IS NOT NULL
  AND a."id" <> (
    SELECT b."id" FROM "agents" b
    JOIN "users" u ON u."id" = b."service_user_id"
    WHERE b."service_user_id" = a."service_user_id"
    ORDER BY (u."email" = 'svc-' || b."id"::text || '@clawhub.invalid') DESC, b."created_at" ASC, b."id" ASC
    LIMIT 1
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_service_user_uniq" ON "agents" USING btree ("service_user_id") WHERE service_user_id is not null;