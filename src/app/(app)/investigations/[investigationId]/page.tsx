import { notFound } from "next/navigation";

import { getAppContext } from "@/app/(app)/app-session";
import { InvestigationDetail } from "@/components/investigations/investigation-detail";
import {
  CollaborationInvestigationCasesDocument,
  CollaborationInvestigationDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export const dynamic = "force-dynamic";

export default async function InvestigationDetailPage({
  params,
}: {
  params: Promise<{ investigationId: string }>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const { investigationId } = await params;
  const [investigationResult, casesResult] = await Promise.all([
    executeServerGraphQL(CollaborationInvestigationDocument, {
      id: investigationId,
    }),
    executeServerGraphQL(CollaborationInvestigationCasesDocument, {
      investigationId,
    }),
  ]);
  if (!investigationResult.investigation || !casesResult.investigationCases) {
    notFound();
  }
  return (
    <InvestigationDetail
      investigation={investigationResult.investigation}
      initialCases={casesResult.investigationCases}
      canEdit={context.viewer.permissions.includes("investigation:update")}
    />
  );
}
