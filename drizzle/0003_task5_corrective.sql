CREATE TABLE "workspace_principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"user_id" text,
	"member_id_snapshot" text,
	"api_key_id" text,
	"system_key" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_principals_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_principals_workspace_user_unique" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "workspace_principals_workspace_api_key_unique" UNIQUE("workspace_id","api_key_id"),
	CONSTRAINT "workspace_principals_workspace_system_unique" UNIQUE("workspace_id","system_key"),
	CONSTRAINT "workspace_principals_identity_check" CHECK (("workspace_principals"."principal_type" = 'user'
            AND "workspace_principals"."user_id" IS NOT NULL
            AND "workspace_principals"."member_id_snapshot" IS NOT NULL
            AND "workspace_principals"."api_key_id" IS NULL
            AND "workspace_principals"."system_key" IS NULL)
          OR ("workspace_principals"."principal_type" = 'api_key'
            AND "workspace_principals"."user_id" IS NULL
            AND "workspace_principals"."member_id_snapshot" IS NULL
            AND "workspace_principals"."api_key_id" IS NOT NULL
            AND "workspace_principals"."system_key" IS NULL)
          OR ("workspace_principals"."principal_type" = 'system'
            AND "workspace_principals"."user_id" IS NULL
            AND "workspace_principals"."member_id_snapshot" IS NULL
            AND "workspace_principals"."api_key_id" IS NULL
            AND "workspace_principals"."system_key" IS NOT NULL)
          OR ("workspace_principals"."principal_type" = 'legacy_user'
            AND "workspace_principals"."user_id" IS NOT NULL
            AND "workspace_principals"."member_id_snapshot" IS NULL
            AND "workspace_principals"."api_key_id" IS NULL
            AND "workspace_principals"."system_key" IS NULL)
          OR ("workspace_principals"."principal_type" = 'legacy_api_key'
            AND "workspace_principals"."user_id" IS NULL
            AND "workspace_principals"."member_id_snapshot" IS NULL
            AND "workspace_principals"."api_key_id" IS NOT NULL
            AND "workspace_principals"."system_key" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_events" RENAME COLUMN "actor_id" TO "actor_user_id";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_check";--> statement-breakpoint
ALTER TABLE "ai_citations" DROP CONSTRAINT "ai_citations_workspace_run_fk";--> statement-breakpoint
ALTER TABLE "ai_citations" DROP CONSTRAINT "ai_citations_workspace_message_fk";--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_workspace_message_fk";--> statement-breakpoint
ALTER TABLE "ai_citations" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "updated_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN "legacy_message_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_principals" ADD CONSTRAINT "workspace_principals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_principals_workspace_type_idx" ON "workspace_principals" USING btree ("workspace_id","principal_type");--> statement-breakpoint

-- Migration-only deterministic UUIDv7-shaped IDs make remediation idempotent
-- without requiring an extension. Runtime IDs continue to come from newId().
CREATE FUNCTION public.task5_migration_uuidv7(namespace text, value text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT (
    substr(hash, 1, 8) || '-' ||
    substr(hash, 9, 4) || '-' ||
    '7' || substr(hash, 14, 3) || '-' ||
    '8' || substr(hash, 18, 3) || '-' ||
    substr(hash, 21, 12)
  )::uuid
  FROM (SELECT md5(namespace || ':' || value) AS hash) AS digest
$$;--> statement-breakpoint

-- Older schemas allowed organization API keys before an application workspace
-- existed. Preserve those keys by creating the missing one-to-one workspace.
WITH missing AS (
  SELECT DISTINCT organization.id, organization.name
  FROM public.organizations AS organization
  JOIN public.api_keys AS api_key
    ON api_key.reference_id = organization.id
  LEFT JOIN public.workspaces AS workspace
    ON workspace.organization_id = organization.id
  WHERE workspace.id IS NULL
)
INSERT INTO public.workspaces (
  id,
  organization_id,
  name,
  created_by,
  updated_by
)
SELECT
  public.task5_migration_uuidv7('workspace', missing.id),
  missing.id,
  missing.name,
  COALESCE((
    SELECT member.user_id
    FROM public.members AS member
    WHERE member.organization_id = missing.id
    ORDER BY member.created_at, member.id
    LIMIT 1
  ), 'migration:task5'),
  COALESCE((
    SELECT member.user_id
    FROM public.members AS member
    WHERE member.organization_id = missing.id
    ORDER BY member.created_at, member.id
    LIMIT 1
  ), 'migration:task5')
FROM missing
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

DO $$
DECLARE
  unresolved_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM public.api_keys AS api_key
  LEFT JOIN public.workspaces AS workspace
    ON workspace.organization_id = api_key.reference_id
  WHERE workspace.id IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Task 5 migration could not map % organization API key(s) to a workspace', unresolved_count
      USING ERRCODE = '23503',
        HINT = 'Resolve duplicate/colliding organization workspace data, then rerun the migration.';
  END IF;
END;
$$;--> statement-breakpoint

UPDATE public.api_keys AS api_key
SET workspace_id = workspace.id
FROM public.workspaces AS workspace
WHERE workspace.organization_id = api_key.reference_id;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.populate_member_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  derived_workspace_id uuid;
BEGIN
  SELECT workspace.id INTO derived_workspace_id
  FROM public.workspaces AS workspace
  WHERE workspace.organization_id = NEW.organization_id;

  IF derived_workspace_id IS NULL THEN
    RAISE EXCEPTION 'member organization has no application workspace'
      USING ERRCODE = '23503';
  END IF;

  NEW.workspace_id := derived_workspace_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER members_populate_workspace_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id
ON public.members
FOR EACH ROW
EXECUTE FUNCTION public.populate_member_workspace();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.populate_api_key_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  derived_workspace_id uuid;
BEGIN
  SELECT workspace.id INTO derived_workspace_id
  FROM public.workspaces AS workspace
  WHERE workspace.organization_id = NEW.reference_id;

  IF derived_workspace_id IS NULL THEN
    RAISE EXCEPTION 'API key organization has no application workspace'
      USING ERRCODE = '23503';
  END IF;

  NEW.workspace_id := derived_workspace_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER api_keys_populate_workspace_trigger
BEFORE INSERT OR UPDATE OF reference_id, workspace_id
ON public.api_keys
FOR EACH ROW
EXECUTE FUNCTION public.populate_api_key_workspace();--> statement-breakpoint

-- A citation whose message belonged to another thread was legal in 0002.
-- Keep the original UUID as an explicit snapshot while removing the invalid
-- live message reference; the citation remains attached to its AI run/thread.
UPDATE public.ai_citations AS citation
SET thread_id = run.thread_id
FROM public.ai_runs AS run
WHERE run.workspace_id = citation.workspace_id
  AND run.id = citation.ai_run_id;--> statement-breakpoint
UPDATE public.ai_citations AS citation
SET legacy_message_id = citation.message_id,
    message_id = NULL
FROM public.ai_messages AS message
WHERE message.workspace_id = citation.workspace_id
  AND message.id = citation.message_id
  AND message.thread_id <> citation.thread_id;--> statement-breakpoint

-- 0002 also permitted an AI run to name an input message from another thread.
-- Preserve that UUID in the run's migration metadata before dropping the
-- incompatible live reference.
UPDATE public.ai_runs AS run
SET capability_profile = run.capability_profile || jsonb_build_object(
      'migration',
      COALESCE(run.capability_profile -> 'migration', '{}'::jsonb) ||
        jsonb_build_object('legacyMessageId', run.message_id::text)
    ),
    message_id = NULL
FROM public.ai_messages AS message
WHERE message.workspace_id = run.workspace_id
  AND message.id = run.message_id
  AND message.thread_id <> run.thread_id;--> statement-breakpoint

DO $$
DECLARE
  unresolved_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM public.ai_citations
  WHERE thread_id IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Task 5 migration could not derive a thread for % AI citation(s)', unresolved_count
      USING ERRCODE = '23503',
        HINT = 'Repair orphan AI-run references before rerunning the migration.';
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "ai_citations" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspace_thread_id_unique" UNIQUE("workspace_id","thread_id","id");--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_thread_id_unique" UNIQUE("workspace_id","thread_id","id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_user_unique" UNIQUE("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_unique" UNIQUE("user_id","id");--> statement-breakpoint

-- First preserve validated live principals, then quarantine any historically
-- unvalidated 0002 attribution as legacy snapshots. The validation trigger
-- installed below refuses creation of new legacy principals.
INSERT INTO public.workspace_principals (
  id,
  workspace_id,
  principal_type,
  user_id,
  member_id_snapshot
)
SELECT
  public.task5_migration_uuidv7('user-principal', member.workspace_id::text || ':' || member.user_id),
  member.workspace_id,
  'user',
  member.user_id,
  member.id
FROM public.members AS member
ON CONFLICT (workspace_id, user_id) DO NOTHING;--> statement-breakpoint

INSERT INTO public.workspace_principals (
  id,
  workspace_id,
  principal_type,
  api_key_id
)
SELECT
  public.task5_migration_uuidv7('api-key-principal', api_key.workspace_id::text || ':' || api_key.id),
  api_key.workspace_id,
  'api_key',
  api_key.id
FROM public.api_keys AS api_key
ON CONFLICT (workspace_id, api_key_id) DO NOTHING;--> statement-breakpoint

WITH actor_snapshots AS (
  SELECT workspace_id, owner_id AS user_id FROM public.saved_queries
  UNION SELECT workspace_id, actor_id FROM public.query_runs
  UNION SELECT workspace_id, uploaded_by FROM public.files
  UNION SELECT workspace_id, actor_id FROM public.upload_sessions
  UNION SELECT workspace_id, created_by FROM public.imports
  UNION SELECT workspace_id, owner_id FROM public.graph_views
  UNION SELECT workspace_id, owner_id FROM public.ai_threads
  UNION SELECT workspace_id, created_by FROM public.ai_messages
  UNION SELECT workspace_id, created_by FROM public.ai_runs
  UNION SELECT workspace_id, created_by FROM public.jobs WHERE created_by IS NOT NULL
  UNION SELECT workspace_id, updated_by FROM public.jobs WHERE updated_by IS NOT NULL
  UNION SELECT workspace_id, actor_user_id FROM public.audit_events WHERE actor_user_id IS NOT NULL
  UNION SELECT workspace_id, actor_id FROM public.idempotency_keys
  UNION SELECT workspace_id, created_by FROM public.webhooks
)
INSERT INTO public.workspace_principals (
  id,
  workspace_id,
  principal_type,
  user_id
)
SELECT
  public.task5_migration_uuidv7('legacy-user-principal', actor.workspace_id::text || ':' || actor.user_id),
  actor.workspace_id,
  'legacy_user',
  actor.user_id
FROM actor_snapshots AS actor
LEFT JOIN public.workspace_principals AS principal
  ON principal.workspace_id = actor.workspace_id
  AND principal.user_id = actor.user_id
WHERE principal.id IS NULL
ON CONFLICT (workspace_id, user_id) DO NOTHING;--> statement-breakpoint

INSERT INTO public.workspace_principals (
  id,
  workspace_id,
  principal_type,
  api_key_id
)
SELECT
  public.task5_migration_uuidv7('legacy-api-key-principal', audit.workspace_id::text || ':' || audit.api_key_id),
  audit.workspace_id,
  'legacy_api_key',
  audit.api_key_id
FROM public.audit_events AS audit
LEFT JOIN public.workspace_principals AS principal
  ON principal.workspace_id = audit.workspace_id
  AND principal.api_key_id = audit.api_key_id
WHERE audit.api_key_id IS NOT NULL
  AND principal.id IS NULL
ON CONFLICT (workspace_id, api_key_id) DO NOTHING;--> statement-breakpoint

DROP FUNCTION public.task5_migration_uuidv7(text, text);--> statement-breakpoint

ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_workspace_run_fk" FOREIGN KEY ("workspace_id","thread_id","ai_run_id") REFERENCES "public"."ai_runs"("workspace_id","thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_workspace_message_fk" FOREIGN KEY ("workspace_id","thread_id","message_id") REFERENCES "public"."ai_messages"("workspace_id","thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_input_message_fk" FOREIGN KEY ("workspace_id","thread_id","message_id") REFERENCES "public"."ai_messages"("workspace_id","thread_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_organization_fk" FOREIGN KEY ("workspace_id","reference_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_uploader_fk" FOREIGN KEY ("workspace_id","uploaded_by") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_views" ADD CONSTRAINT "graph_views_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_actor_fk" FOREIGN KEY ("workspace_id","actor_user_id") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_api_key_fk" FOREIGN KEY ("workspace_id","api_key_id") REFERENCES "public"."workspace_principals"("workspace_id","api_key_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_updater_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_workspace_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."workspace_principals"("workspace_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_documents_search_vector_gin" ON "search_documents" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_message_identity_check" CHECK (num_nonnulls("ai_citations"."message_id", "ai_citations"."legacy_message_id") = 1);--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_subject_check" CHECK (num_nonnulls("notes"."person_id", "notes"."fact_id", "notes"."relationship_id", "notes"."evidence_item_id") <= 1);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check" CHECK (NOT ("audit_events"."api_key_id" IS NOT NULL AND num_nonnulls("audit_events"."actor_user_id", "audit_events"."session_id") > 0)
        AND ("audit_events"."session_id" IS NULL OR "audit_events"."actor_user_id" IS NOT NULL));--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.prevent_ai_citation_legacy_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.legacy_message_id IS NOT NULL OR NEW.message_id IS NULL THEN
      RAISE EXCEPTION 'new AI citations must reference a live message in the run thread'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.legacy_message_id IS DISTINCT FROM OLD.legacy_message_id THEN
    RAISE EXCEPTION 'legacy AI citation message snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ai_citations_legacy_guard_trigger
BEFORE INSERT OR UPDATE
ON public.ai_citations
FOR EACH ROW
EXECUTE FUNCTION public.prevent_ai_citation_legacy_writes();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.validate_workspace_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- PostgreSQL removes the parent workspace before invoking child CASCADE
    -- triggers. Permit only that nested tenant-purge path; direct deletion is
    -- forbidden even when no domain row currently references the principal.
    IF pg_trigger_depth() > 1
      AND NOT EXISTS (
        SELECT 1
        FROM public.workspaces AS workspace
        WHERE workspace.id = OLD.workspace_id
      )
    THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION 'workspace principal history is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'workspace principal history is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.principal_type = 'user' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.members AS member
      WHERE member.workspace_id = NEW.workspace_id
        AND member.user_id = NEW.user_id
        AND member.id = NEW.member_id_snapshot
    ) THEN
      RAISE EXCEPTION 'user principal is not an active workspace member'
        USING ERRCODE = '23503';
    END IF;
  ELSIF NEW.principal_type = 'api_key' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.api_keys AS api_key
      WHERE api_key.workspace_id = NEW.workspace_id
        AND api_key.id = NEW.api_key_id
        AND api_key.enabled IS NOT FALSE
        AND (api_key.expires_at IS NULL OR api_key.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'API-key principal is not active in this workspace'
        USING ERRCODE = '23503';
    END IF;
  ELSIF NEW.principal_type IN ('legacy_user', 'legacy_api_key') THEN
    RAISE EXCEPTION 'legacy principals may only be created by the Task 5 migration'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workspace_principals_validate_trigger
BEFORE INSERT OR UPDATE OR DELETE
ON public.workspace_principals
FOR EACH ROW
EXECUTE FUNCTION public.validate_workspace_principal();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.validate_workspace_user_attribution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attributed_user_id text;
BEGIN
  attributed_user_id := to_jsonb(NEW) ->> TG_ARGV[0];
  IF attributed_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.members AS member
      WHERE member.workspace_id = NEW.workspace_id
        AND member.user_id = attributed_user_id
    )
  THEN
    RAISE EXCEPTION 'attributed user is not an active workspace member'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER saved_queries_validate_owner_trigger BEFORE INSERT OR UPDATE OF workspace_id, owner_id ON public.saved_queries FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('owner_id');--> statement-breakpoint
CREATE TRIGGER query_runs_validate_actor_trigger BEFORE INSERT OR UPDATE OF workspace_id, actor_id ON public.query_runs FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('actor_id');--> statement-breakpoint
CREATE TRIGGER files_validate_uploader_trigger BEFORE INSERT OR UPDATE OF workspace_id, uploaded_by ON public.files FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('uploaded_by');--> statement-breakpoint
CREATE TRIGGER upload_sessions_validate_actor_trigger BEFORE INSERT OR UPDATE OF workspace_id, actor_id ON public.upload_sessions FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('actor_id');--> statement-breakpoint
CREATE TRIGGER imports_validate_actor_trigger BEFORE INSERT OR UPDATE OF workspace_id, created_by ON public.imports FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('created_by');--> statement-breakpoint
CREATE TRIGGER graph_views_validate_owner_trigger BEFORE INSERT OR UPDATE OF workspace_id, owner_id ON public.graph_views FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('owner_id');--> statement-breakpoint
CREATE TRIGGER ai_threads_validate_owner_trigger BEFORE INSERT OR UPDATE OF workspace_id, owner_id ON public.ai_threads FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('owner_id');--> statement-breakpoint
CREATE TRIGGER ai_messages_validate_actor_trigger BEFORE INSERT OR UPDATE OF workspace_id, created_by ON public.ai_messages FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('created_by');--> statement-breakpoint
CREATE TRIGGER ai_runs_validate_actor_trigger BEFORE INSERT OR UPDATE OF workspace_id, created_by ON public.ai_runs FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('created_by');--> statement-breakpoint
CREATE TRIGGER jobs_validate_creator_trigger BEFORE INSERT OR UPDATE OF workspace_id, created_by ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('created_by');--> statement-breakpoint
CREATE TRIGGER jobs_validate_updater_trigger BEFORE INSERT OR UPDATE OF workspace_id, updated_by ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('updated_by');--> statement-breakpoint
CREATE TRIGGER idempotency_keys_validate_actor_trigger BEFORE INSERT OR UPDATE OF workspace_id, actor_id ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('actor_id');--> statement-breakpoint
CREATE TRIGGER webhooks_validate_creator_trigger BEFORE INSERT OR UPDATE OF workspace_id, created_by ON public.webhooks FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_user_attribution('created_by');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.validate_audit_event_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.members AS member
      WHERE member.workspace_id = NEW.workspace_id
        AND member.user_id = NEW.actor_user_id
    ) THEN
      RAISE EXCEPTION 'audit actor is not an active workspace member'
        USING ERRCODE = '23503';
    END IF;

    IF NEW.session_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.sessions AS session
      WHERE session.id = NEW.session_id
        AND session.user_id = NEW.actor_user_id
        AND session.expires_at > now()
    ) THEN
      RAISE EXCEPTION 'audit session is not active for this actor'
        USING ERRCODE = '23503';
    END IF;
  ELSIF NEW.api_key_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.api_keys AS api_key
      WHERE api_key.workspace_id = NEW.workspace_id
        AND api_key.id = NEW.api_key_id
        AND api_key.enabled IS NOT FALSE
        AND (api_key.expires_at IS NULL OR api_key.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'audit API key is not active in this workspace'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_validate_actor_trigger
BEFORE INSERT
ON public.audit_events
FOR EACH ROW
EXECUTE FUNCTION public.validate_audit_event_actor();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Workspace deletion is an explicit tenant purge and invokes this trigger
  -- recursively through the workspace FK's CASCADE action.
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND NOT EXISTS (
      SELECT 1
      FROM public.workspaces AS workspace
      WHERE workspace.id = OLD.workspace_id
    )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit events are immutable'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_immutable_trigger
BEFORE UPDATE OR DELETE
ON public.audit_events
FOR EACH ROW
EXECUTE FUNCTION public.prevent_audit_event_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_relationship_self_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  self_allowed boolean;
BEGIN
  IF NEW.source_person_id = NEW.target_person_id THEN
    SELECT allows_self INTO self_allowed
    FROM public.relationship_types
    WHERE workspace_id = NEW.workspace_id
      AND id = NEW.relationship_type_id
    FOR UPDATE;

    IF self_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'relationship type does not allow self relationships'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prevent_disabling_relationship_self_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.allows_self = true
    AND NEW.allows_self = false
    AND EXISTS (
      SELECT 1
      FROM public.relationships
      WHERE workspace_id = NEW.workspace_id
        AND relationship_type_id = NEW.id
        AND source_person_id = target_person_id
    )
  THEN
    RAISE EXCEPTION 'relationship type still has self relationships'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER relationship_types_self_policy_trigger
BEFORE UPDATE OF allows_self
ON public.relationship_types
FOR EACH ROW
EXECUTE FUNCTION public.prevent_disabling_relationship_self_policy();
