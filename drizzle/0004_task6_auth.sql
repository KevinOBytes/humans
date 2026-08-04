UPDATE "members"
SET "role" = 'viewer'
WHERE "role" = 'member';--> statement-breakpoint
UPDATE "invitations"
SET "role" = 'viewer'
WHERE "role" = 'member';--> statement-breakpoint
DO $task6_auth_roles$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "members"
    WHERE "role" NOT IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Task 6 migration cannot continue: members contain unsupported workspace roles; map every role to owner, admin, analyst, contributor, or viewer before retrying';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "invitations"
    WHERE "role" IS NOT NULL
      AND "role" NOT IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Task 6 migration cannot continue: invitations contain unsupported workspace roles; map every role to owner, admin, analyst, contributor, or viewer before retrying';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "users"
    WHERE "role" IS NOT NULL
      AND "role" NOT IN ('user', 'admin')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Task 6 migration cannot continue: users contain unsupported global roles; map every role to user or admin before retrying';
  END IF;
END
$task6_auth_roles$;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "role" SET DEFAULT 'viewer';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_role_check" CHECK ("invitations"."role" IS NULL OR "invitations"."role" IN ('owner', 'admin', 'analyst', 'contributor', 'viewer'));--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_role_check" CHECK ("members"."role" IN ('owner', 'admin', 'analyst', 'contributor', 'viewer'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_global_role_check" CHECK ("users"."role" IS NULL OR "users"."role" IN ('user', 'admin'));
