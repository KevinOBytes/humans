import { getAppContext } from "@/app/(app)/app-session";
import { CaseWorkspace } from "@/components/cases/case-workspace";
import { ResearchCasesDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const { after } = await searchParams;
  const result = await executeServerGraphQL(ResearchCasesDocument, {
    first: 25,
    ...(after ? { after } : {}),
  });
  return <CaseWorkspace cases={result.researchCases} />;
}
