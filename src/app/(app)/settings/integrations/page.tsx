import { getAdministrativeSettingsContext } from "@/app/(app)/settings/settings-context";
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { Badge } from "@/components/ui/badge";
import { getIntegrationDiagnostics } from "@/modules/settings/integration-diagnostics";

export default async function IntegrationsSettingsPage() {
  await getAdministrativeSettingsContext();
  const diagnostics = getIntegrationDiagnostics();
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="Integrations"
        description="Configuration and capability status from validated server configuration. Rendering this page does not contact email, PostgreSQL, Redis, object storage, or an AI provider."
      />
      <SettingsCard
        title="Configured capabilities"
        description="Credentials, private endpoints, bucket names, and environment values are never shown."
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {diagnostics.map((diagnostic) => (
            <li
              key={diagnostic.name}
              className="border-border rounded-xl border p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">{diagnostic.name}</p>
                <Badge>{diagnostic.status}</Badge>
              </div>
              <p className="text-muted-foreground mt-2 text-sm">
                {diagnostic.detail}
              </p>
            </li>
          ))}
        </ul>
      </SettingsCard>
      <SettingsCard
        title="Provider settings"
        description="AI provider configuration is intentionally unavailable until Task 13 delivers the reviewed encrypted secret, policy, SSRF, and generated-operation backend."
      >
        <p className="text-muted-foreground text-sm">
          No provider connection or capability probe is performed during page
          render.
        </p>
      </SettingsCard>
    </div>
  );
}
