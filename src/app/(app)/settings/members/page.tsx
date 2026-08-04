import { MemberAdministration } from "@/components/settings/member-administration";
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";

export default function MembersSettingsPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="Members"
        description="Invite collaborators and manage workspace roles through audited application transactions."
      />
      <SettingsCard
        title="Workspace access"
        description="Owner invitations and self-service owner transfer are intentionally outside this release."
      >
        <MemberAdministration />
      </SettingsCard>
    </div>
  );
}
