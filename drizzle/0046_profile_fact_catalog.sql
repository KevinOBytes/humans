-- Provision the same governed rich-profile definition catalog for workspaces
-- that predate application-level workspace provisioning. Values remain empty;
-- this migration only creates definition rows and is safe to replay.
WITH profile_fields(namespace, field_key, label, description, category,
                    allowed_value_type, cardinality, searchable, filterable,
                    graphable, default_sensitivity, state) AS (
  VALUES
    ('profile', 'pronouns', 'Pronouns',
      'A person-provided or source-backed pronoun set.', 'identity',
      'text', 'many', true, true, false, 'internal', 'active'),
    ('profile', 'employment', 'Employment',
      'An employment role, employer, or employment period.', 'work',
      'text', 'many', true, true, true, 'internal', 'active'),
    ('profile', 'education', 'Education',
      'An educational institution, program, or qualification.', 'background',
      'text', 'many', true, true, false, 'internal', 'active'),
    ('profile', 'language', 'Language',
      'A language associated with the person and its evidence.', 'profile',
      'text', 'many', true, true, false, 'internal', 'active'),
    ('profile', 'organization', 'Organization',
      'An organization affiliation or membership claim.', 'affiliation',
      'text', 'many', true, true, true, 'internal', 'active'),
    ('profile', 'birth_date', 'Birth date',
      'A date or date range associated with birth evidence.', 'identity',
      'date', 'one', true, true, false, 'confidential', 'active'),
    ('profile', 'custom_note', 'Custom profile field',
      'A workspace-defined JSON value; do not use it to bypass sensitivity or provenance controls.', 'custom',
      'json', 'many', false, false, false, 'internal', 'active')
)
INSERT INTO "fact_definitions" (
  "id", "workspace_id", "namespace", "field_key", "label", "description",
  "category", "allowed_value_type", "cardinality", "searchable", "filterable",
  "graphable", "default_sensitivity", "state", "created_by", "updated_by"
)
SELECT
  md5(w."id"::text || ':profile:' || p.field_key)::uuid,
  w."id", p.namespace, p.field_key, p.label, p.description, p.category,
  p.allowed_value_type::"fact_value_type",
  p.cardinality::"fact_cardinality",
  p.searchable, p.filterable, p.graphable,
  p.default_sensitivity::"sensitivity",
  p.state::"fact_definition_state",
  COALESCE(
    (SELECT wp."id"::text FROM "workspace_principals" AS wp
     WHERE wp."workspace_id" = w."id"
       AND wp."user_id" = w."created_by"
     ORDER BY wp."id"
     LIMIT 1),
    w."created_by"
  ),
  COALESCE(
    (SELECT wp."id"::text FROM "workspace_principals" AS wp
     WHERE wp."workspace_id" = w."id"
       AND wp."user_id" = w."updated_by"
     ORDER BY wp."id"
     LIMIT 1),
    w."updated_by"
  )
FROM "workspaces" AS w
CROSS JOIN profile_fields AS p
ON CONFLICT ("workspace_id", "namespace", "field_key") DO NOTHING;
