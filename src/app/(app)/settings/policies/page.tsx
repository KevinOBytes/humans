import { getAdministrativeSettingsContext } from "@/app/(app)/settings/settings-context";
import {
  DefinitionList,
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { PolicyAdministration } from "@/components/settings/policy-administration";
import { Badge } from "@/components/ui/badge";
import { SettingsPolicyPostureDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export default async function PoliciesSettingsPage() {
  await getAdministrativeSettingsContext();
  const data = await executeServerGraphQL(SettingsPolicyPostureDocument, {});
  const settings = data.settingsPolicyPosture;
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="Policies"
        description="Manage workspace defaults and review access, grant, and retention posture. Raw policy JSON is never exposed."
      />
      <SettingsCard title="Workspace defaults">
        <PolicyAdministration
          version={settings.workspace.version}
          locale={settings.workspace.locale}
          timezone={settings.workspace.timezone}
          retentionDays={settings.workspace.defaultRetentionDays}
          aiEnabled={settings.workspace.aiEnabled}
          retainRestrictedAiPrompts={
            settings.workspace.retainRestrictedAiPrompts
          }
          storageEnabled={settings.workspace.storageEnabled}
        />
      </SettingsCard>
      <SettingsCard title="Workspace posture">
        <DefinitionList
          items={[
            { label: "Workspace", value: settings.workspace.name },
            { label: "Locale", value: settings.workspace.locale },
            { label: "Time zone", value: settings.workspace.timezone },
            {
              label: "Default retention",
              value:
                settings.workspace.defaultRetentionDays == null
                  ? "No automatic expiry"
                  : `${settings.workspace.defaultRetentionDays} days`,
            },
            {
              label: "Storage feature",
              value: settings.workspace.storageEnabled ? "Enabled" : "Disabled",
            },
            {
              label: "AI feature flag",
              value: settings.workspace.aiEnabled ? "Enabled" : "Disabled",
            },
            {
              label: "Restricted AI prompt retention",
              value: settings.workspace.retainRestrictedAiPrompts
                ? "Explicitly enabled"
                : "Omitted by default",
            },
          ]}
        />
      </SettingsCard>
      <SettingsCard
        title="Access-policy posture"
        description="Role-binding JSON stays server-side while policy versions and grants remain auditable."
      >
        <ul className="grid gap-3">
          {settings.accessPolicies.map((policy) => (
            <li key={policy.id} className="border-border rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-medium">{policy.name}</p>
                <Badge>{policy.state}</Badge>
              </div>
              <p className="text-muted-foreground mt-2 text-sm">
                Ceiling: {policy.sensitivityCeiling} · Resources:{" "}
                {policy.resourceKinds.join(", ") || "None"}
              </p>
            </li>
          ))}
          {settings.accessPolicies.length === 0 ? (
            <li className="text-muted-foreground py-4 text-sm">
              No access policies are configured.
            </li>
          ) : null}
        </ul>
      </SettingsCard>
      <SettingsCard title="Retention posture">
        <ul className="grid gap-3 sm:grid-cols-2">
          {settings.retentionPolicies.map((policy) => (
            <li
              key={policy.resourceKind}
              className="border-border rounded-xl border p-4 text-sm"
            >
              <p className="font-medium">{policy.resourceKind}</p>
              <p className="text-muted-foreground mt-1">
                {policy.retentionDays} days · {policy.deletionBehavior}
              </p>
            </li>
          ))}
          {settings.retentionPolicies.length === 0 ? (
            <li className="text-muted-foreground py-4 text-sm">
              No resource-specific retention policies are configured.
            </li>
          ) : null}
        </ul>
      </SettingsCard>
      <SettingsCard title="Security and provider posture">
        <DefinitionList
          items={[
            { label: "Verified invitations", value: "Required" },
            { label: "Organization deletion", value: "Disabled" },
            {
              label: "Provider configuration",
              value: "Configured through the deployment provider boundary",
            },
          ]}
        />
      </SettingsCard>
    </div>
  );
}
