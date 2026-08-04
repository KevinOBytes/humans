CREATE OR REPLACE FUNCTION public.prevent_fact_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fact revisions are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_revisions_immutable_trigger
BEFORE UPDATE OR DELETE ON public.fact_revisions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_fact_revision_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prevent_fact_supersession_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cycle_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
    AND NEW.supersedes_fact_id IS NOT DISTINCT FROM OLD.supersedes_fact_id
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.supersedes_fact_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.workspaces
  WHERE id = NEW.workspace_id
  FOR UPDATE;

  IF NEW.supersedes_fact_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.supersedes_fact_id = NEW.id THEN
    RAISE EXCEPTION 'a fact cannot supersede itself'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE supersession_chain(id, supersedes_fact_id) AS (
    SELECT fact.id, fact.supersedes_fact_id
    FROM public.facts AS fact
    WHERE fact.workspace_id = NEW.workspace_id
      AND fact.id = NEW.supersedes_fact_id

    UNION

    SELECT fact.id, fact.supersedes_fact_id
    FROM public.facts AS fact
    INNER JOIN supersession_chain AS chain
      ON fact.workspace_id = NEW.workspace_id
      AND fact.id = chain.supersedes_fact_id
  )
  SELECT EXISTS (
    SELECT 1
    FROM supersession_chain
    WHERE id = NEW.id
  ) INTO cycle_found;

  IF cycle_found THEN
    RAISE EXCEPTION 'fact supersession would create a cycle'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER facts_supersession_cycle_trigger
BEFORE INSERT OR UPDATE OF id, workspace_id, supersedes_fact_id
ON public.facts
FOR EACH ROW
EXECUTE FUNCTION public.prevent_fact_supersession_cycle();
