-- Normalize the values constrained by this migration before installing the
-- constraints. Pre-Task-18 contact kinds were intentionally open text, so keep
-- the original value in metadata when it cannot be mapped without loss.
UPDATE "contact_points"
SET
  "metadata" = CASE
    WHEN lower(btrim("kind")) IN ('phone', 'email', 'other') THEN "metadata"
    WHEN jsonb_typeof("metadata") = 'object' THEN
      "metadata" || jsonb_build_object('task18LegacyKind', "kind")
    ELSE
      jsonb_build_object(
        'task18LegacyKind', "kind",
        'task18LegacyMetadata', "metadata"
      )
  END,
  "kind" = CASE
    WHEN lower(btrim("kind")) IN ('phone', 'email', 'other')
      THEN lower(btrim("kind"))
    ELSE 'other'
  END,
  "version" = "version" + 1,
  "updated_at" = transaction_timestamp()
WHERE "kind" NOT IN ('phone', 'email', 'other');
--> statement-breakpoint
-- A pre-Task-18 normalized_hash had no enforced algorithm or shape. Replace
-- malformed values with a deterministic opaque per-row migration marker. It
-- deliberately excludes the legacy value so a plaintext-like legacy hash is
-- not preserved through an unsalted digest. The next application update will
-- replace this marker with the canonical workspace-bound HMAC.
UPDATE "addresses"
SET
  "normalized_hash" =
    md5('humans:task18:legacy-address:a:' || "workspace_id"::text || ':' || "id"::text) ||
    md5('humans:task18:legacy-address:b:' || "workspace_id"::text || ':' || "id"::text),
  "version" = "version" + 1,
  "updated_at" = transaction_timestamp()
WHERE "normalized_hash" !~ '^[0-9a-f]{64}$';
--> statement-breakpoint
-- Existing primary flags were legal before Task 18. Preserve the most recently
-- updated current primary in each scope and demote only the deterministic
-- remainder before creating the partial unique indexes.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workspace_id", "person_id", "address_kind"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" ASC
    ) AS ordinal
  FROM "person_addresses"
  WHERE "is_primary"
    AND "deleted_at" IS NULL
    AND "valid_until" IS NULL
)
UPDATE "person_addresses" AS association
SET
  "is_primary" = false,
  "version" = association."version" + 1,
  "updated_at" = transaction_timestamp()
FROM ranked
WHERE association."id" = ranked."id"
  AND ranked.ordinal > 1;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workspace_id", "person_id", "usage_kind"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" ASC
    ) AS ordinal
  FROM "person_contact_points"
  WHERE "is_primary"
    AND "deleted_at" IS NULL
    AND "valid_until" IS NULL
)
UPDATE "person_contact_points" AS association
SET
  "is_primary" = false,
  "version" = association."version" + 1,
  "updated_at" = transaction_timestamp()
FROM ranked
WHERE association."id" = ranked."id"
  AND ranked.ordinal > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "person_addresses_current_primary_unique" ON "person_addresses" USING btree ("workspace_id","person_id","address_kind") WHERE "person_addresses"."is_primary" AND "person_addresses"."deleted_at" IS NULL AND "person_addresses"."valid_until" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "person_contact_points_current_primary_unique" ON "person_contact_points" USING btree ("workspace_id","person_id","usage_kind") WHERE "person_contact_points"."is_primary" AND "person_contact_points"."deleted_at" IS NULL AND "person_contact_points"."valid_until" IS NULL;
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_normalized_hash_check" CHECK ("addresses"."normalized_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_kind_check" CHECK ("contact_points"."kind" IN ('phone', 'email', 'other'));
--> statement-breakpoint
-- Serialize hierarchy changes per workspace at the database boundary. The
-- workspace row lock prevents opposite concurrent reparents from validating
-- against the same pre-change hierarchy.
CREATE OR REPLACE FUNCTION public.prevent_place_parent_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cycle_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
    AND NEW.parent_place_id IS NOT DISTINCT FROM OLD.parent_place_id
  THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.workspaces
  WHERE id = NEW.workspace_id
  FOR UPDATE;

  IF NEW.parent_place_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_place_id = NEW.id THEN
    RAISE EXCEPTION 'a place cannot be its own parent'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE ancestor_chain(id, parent_place_id) AS (
    SELECT place.id, place.parent_place_id
    FROM public.places AS place
    WHERE place.workspace_id = NEW.workspace_id
      AND place.id = NEW.parent_place_id

    UNION

    SELECT place.id, place.parent_place_id
    FROM public.places AS place
    INNER JOIN ancestor_chain AS ancestor
      ON place.workspace_id = NEW.workspace_id
      AND place.id = ancestor.parent_place_id
  )
  SELECT EXISTS (
    SELECT 1
    FROM ancestor_chain
    WHERE id = NEW.id
  ) INTO cycle_found;

  IF cycle_found THEN
    RAISE EXCEPTION 'place parent would create a cycle'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER places_parent_cycle_trigger
BEFORE INSERT OR UPDATE OF id, workspace_id, parent_place_id
ON public.places
FOR EACH ROW
EXECUTE FUNCTION public.prevent_place_parent_cycle();
