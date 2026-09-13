import { getAdministrativeSettingsContext } from "@/app/(app)/settings/settings-context";
import { BreakGlassAdministration } from "@/components/settings/break-glass-administration";
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { BreakGlassAccessRequestsDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export default async function BreakGlassSettingsPage() {
  await getAdministrativeSettingsContext();
  const data = await executeServerGraphQL(BreakGlassAccessRequestsDocument, {
    first: 10,
    after: null,
  });
  const connection = data.breakGlassAccessRequests;
  const requests = (connection?.nodes ?? []).filter(
    (request): request is NonNullable<typeof request> => request !== null,
  );
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="Break-glass access"
        description="Review exceptional, time-limited access requests with explicit resources, independent approval, and immutable audit records."
      />
      <SettingsCard
        title="Exceptional access review"
        description="Use this surface only for documented, consent-governed research purposes. Approvals expire and can be revoked."
      >
        <BreakGlassAdministration
          initialRequests={requests}
          initialPageInfo={{
            hasNextPage: connection?.pageInfo?.hasNextPage === true,
            endCursor: connection?.pageInfo?.endCursor ?? null,
          }}
        />
      </SettingsCard>
    </div>
  );
}
