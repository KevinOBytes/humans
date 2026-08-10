import { notFound } from "next/navigation";

import { getAppContext } from "@/app/(app)/app-session";
import { BrowserAnalyst } from "@/components/ai/analyst-browser-adapter";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function safeUuidList(param: string | string[] | undefined): readonly string[] {
  const candidates = Array.isArray(param)
    ? param.flatMap((s) => s.split(/[\s,]+/u))
    : typeof param === "string"
      ? param.split(/[\s,]+/u)
      : [];
  const ids = candidates
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((s) => UUID.test(s));
  return [...new Set(ids)].slice(0, 100);
}

function safeQuestion(param: string | string[] | undefined): string {
  const candidate = Array.isArray(param) ? param[0] : param;
  if (typeof candidate !== "string") return "";
  const normalized = candidate.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const bytes = new TextEncoder().encode(normalized);
  return new TextDecoder().decode(bytes.slice(0, 8_000));
}

export default async function AnalystPage({
  searchParams,
}: {
  searchParams: Promise<{
    personIds?: string | string[];
    evidenceIds?: string | string[];
    question?: string | string[];
  }>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const permissions = context.viewer.permissions;
  if (!permissions.includes("analysis:read")) notFound();

  const params = await searchParams;
  const initialPersonIds = safeUuidList(params.personIds);
  const initialEvidenceIds = safeUuidList(params.evidenceIds);
  const initialQuestion = safeQuestion(params.question);

  return (
    <BrowserAnalyst
      canCancel={permissions.includes("analysis:cancel")}
      canStart={["analysis:create", "analysis:run"].every((permission) =>
        permissions.includes(permission),
      )}
      initialPersonIds={initialPersonIds}
      initialEvidenceIds={initialEvidenceIds}
      initialQuestion={initialQuestion}
      workspaceIdentity={context.viewer.workspace.id}
    />
  );
}
