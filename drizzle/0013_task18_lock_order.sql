-- A row-level trigger cannot acquire an advisory lock until PostgreSQL has
-- selected and locked its target row. Acquire one conservative hierarchy lock
-- in a statement trigger so direct SQL and application writes share the exact
-- order: hierarchy lock first, then authority/place rows.
CREATE OR REPLACE FUNCTION public.serialize_place_hierarchy_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('humans:place-hierarchy:global', 0)
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS places_hierarchy_serialization_trigger ON public.places;
--> statement-breakpoint
CREATE TRIGGER places_hierarchy_serialization_trigger
BEFORE INSERT OR UPDATE
ON public.places
FOR EACH STATEMENT
EXECUTE FUNCTION public.serialize_place_hierarchy_statement();
--> statement-breakpoint
-- Keep the row trigger responsible only for recursive validation. Serialization
-- has already happened in the statement trigger before any target row lock.
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
