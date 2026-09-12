ALTER TABLE "ai_messages" ADD COLUMN "ai_run_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspace_run_fk" FOREIGN KEY ("workspace_id","thread_id","ai_run_id") REFERENCES "public"."ai_runs"("workspace_id","thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
WITH candidates AS (
  SELECT m.id AS message_id, (array_agg(r.id ORDER BY r.id))[1] AS ai_run_id
  FROM ai_messages AS m
  INNER JOIN ai_runs AS r
    ON r.workspace_id = m.workspace_id
   AND r.thread_id = m.thread_id
  WHERE m.role = 'assistant' AND m.ai_run_id IS NULL
  GROUP BY m.id
  HAVING count(r.id) = 1
)
UPDATE ai_messages AS m
SET ai_run_id = candidates.ai_run_id
FROM candidates
WHERE m.id = candidates.message_id;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_assistant_run_check"
  CHECK ("role" <> 'assistant' OR "ai_run_id" IS NOT NULL) NOT VALID;
