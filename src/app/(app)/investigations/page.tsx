import { InvestigationList } from "@/components/investigations/investigation-list";
import { CollaborationInvestigationsDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { getAppContext } from "@/app/(app)/app-session";

export const dynamic = "force-dynamic";

export default async function InvestigationsPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const { after } = await searchParams;
  const result = await executeServerGraphQL(
    CollaborationInvestigationsDocument,
    {
      first: 25,
      ...(after ? { after } : {}),
    },
  );
  return (
    <div className="space-y-7">
      <header>
        <p className="text-primary text-sm font-semibold">Workspace research</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Investigations
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">
          Organize authorized cases around a documented objective, purpose,
          sensitivity, and accountable lead.
        </p>
      </header>
      <InvestigationList
        investigations={result.investigations!}
        canCreate={context.viewer.permissions.includes("investigation:create")}
      />
    </div>
  );
}
