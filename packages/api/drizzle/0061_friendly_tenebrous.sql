CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"identity_kind" varchar(8) NOT NULL,
	"identity_id" uuid NOT NULL,
	"assigned_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_roles" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_roles" ALTER COLUMN "permissions" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "access_roles" ADD COLUMN "owner_org_id" uuid;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_access_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_uniq" ON "role_assignments" USING btree ("role_id","identity_kind","identity_id");--> statement-breakpoint
CREATE INDEX "role_assignments_identity_idx" ON "role_assignments" USING btree ("identity_kind","identity_id");--> statement-breakpoint
ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_owner_org_id_organizations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_roles_org_idx" ON "access_roles" USING btree ("owner_org_id");--> statement-breakpoint
UPDATE "access_roles" SET "permissions" = (
  SELECT to_jsonb(array_remove(ARRAY[
    'repo:read',
    CASE WHEN COALESCE(("permissions"->>'push')::boolean, true) THEN 'repo:write' END,
    CASE WHEN COALESCE(("permissions"->>'push')::boolean, true) THEN 'change:write' END,
    CASE WHEN COALESCE(("permissions"->>'push')::boolean, true) THEN 'issue:write' END,
    CASE WHEN COALESCE(("permissions"->>'push')::boolean, true) THEN 'workflow:trigger' END,
    CASE WHEN COALESCE(("permissions"->>'review')::boolean, true) THEN 'change:review' END
  ], NULL))
) WHERE jsonb_typeof("permissions") = 'object';--> statement-breakpoint
INSERT INTO "role_assignments" ("role_id", "identity_kind", "identity_id")
SELECT a."access_role_id", 'agent', a."id" FROM "agents" a
WHERE a."access_role_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "access_roles" r WHERE r."id" = a."access_role_id")
ON CONFLICT DO NOTHING;
