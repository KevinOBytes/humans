DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM files AS file
    INNER JOIN file_variants AS variant
      ON variant.workspace_id = file.workspace_id
     AND variant.storage_provider = file.storage_provider
     AND variant.storage_bucket = file.storage_bucket
     AND variant.storage_key = file.storage_key
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Existing file object coordinates have conflicting owners';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "cleanup_completed_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE FUNCTION enforce_file_object_coordinate_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        E'\x1f',
        NEW.workspace_id::text,
        NEW.storage_provider,
        NEW.storage_bucket,
        NEW.storage_key
      ),
      20260804
    )
  );

  IF TG_TABLE_NAME = 'files' THEN
    IF EXISTS (
      SELECT 1
      FROM file_variants AS variant
      WHERE variant.workspace_id = NEW.workspace_id
        AND variant.storage_provider = NEW.storage_provider
        AND variant.storage_bucket = NEW.storage_bucket
        AND variant.storage_key = NEW.storage_key
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'File object coordinate already has an owner';
    END IF;
  ELSIF EXISTS (
    SELECT 1
    FROM files AS file
    WHERE file.workspace_id = NEW.workspace_id
      AND file.storage_provider = NEW.storage_provider
      AND file.storage_bucket = NEW.storage_bucket
      AND file.storage_key = NEW.storage_key
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'File object coordinate already has an owner';
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER files_object_coordinate_guard_trigger
BEFORE INSERT OR UPDATE OF workspace_id, storage_provider, storage_bucket, storage_key
ON files
FOR EACH ROW
EXECUTE FUNCTION enforce_file_object_coordinate_ownership();--> statement-breakpoint
CREATE TRIGGER file_variants_object_coordinate_guard_trigger
BEFORE INSERT OR UPDATE OF workspace_id, storage_provider, storage_bucket, storage_key
ON file_variants
FOR EACH ROW
EXECUTE FUNCTION enforce_file_object_coordinate_ownership();
