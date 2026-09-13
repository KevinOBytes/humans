import { TeamAdministration } from "@/components/teams/team-administration";
import { getAppContext } from "@/app/(app)/app-session";
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";

export default async function TeamsSettingsPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="Teams"
        description="Create reusable collaboration teams and manage their workspace-scoped membership. Sharing a case with a team is an explicit, audited boundary."
      />
      <SettingsCard
        title="Collaboration teams"
        description="The API enforces team ownership, workspace membership, and idempotent audited mutations."
      >
        <TeamAdministration
          canManage={context.viewer.permissions.includes("team:update")}
        />
      </SettingsCard>
    </div>
  );
}
