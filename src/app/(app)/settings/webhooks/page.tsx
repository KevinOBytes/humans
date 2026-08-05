import { getAdministrativeSettingsContext } from "@/app/(app)/settings/settings-context";
import { WebhookAdministration } from "@/components/settings/webhook-administration";
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { WorkspaceWebhooksDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export default async function WebhooksSettingsPage() {
  await getAdministrativeSettingsContext();
  const data = await executeServerGraphQL(WorkspaceWebhooksDocument, {});
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="Webhooks"
        description="Deliver subscribed workspace events to public HTTPS endpoints with signed, retried requests. Secrets are shown only at creation or rotation."
      />
      <SettingsCard title="Webhook endpoints">
        <WebhookAdministration webhooks={data.webhooks.nodes} />
      </SettingsCard>
    </div>
  );
}
