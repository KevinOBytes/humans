import Link from "next/link";

import { getVerifiedAppSession } from "@/app/(app)/app-session";
import {
  DefinitionList,
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { buttonVariants } from "@/components/ui/button";
import { mapAccountSettings } from "@/modules/settings/read-model";

export default async function AccountSettingsPage() {
  const context = await getVerifiedAppSession();
  const account = mapAccountSettings(context.session.user);
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Personal settings"
        title="Account"
        description="Verified profile details for the user attached to this live session. No private identity or session identifiers are sent to the page."
      />
      <SettingsCard
        title="Profile"
        description="Profile changes remain in the existing Better Auth account flow."
      >
        <DefinitionList
          items={[
            { label: "Display name", value: account.displayName },
            { label: "Username", value: account.username ?? "Not set" },
            { label: "Email", value: account.email },
            {
              label: "Email status",
              value: account.emailVerified ? "Verified" : "Not verified",
            },
            {
              label: "Global role",
              value: account.globalAdministrator
                ? "Global administrator"
                : "Standard user",
            },
          ]}
        />
      </SettingsCard>
      <SettingsCard
        title="Password"
        description="Use the established password-reset flow. It keeps account discovery responses indistinguishable."
      >
        <Link
          href="/forgot-password"
          className={buttonVariants({ variant: "outline" })}
        >
          Reset password
        </Link>
      </SettingsCard>
    </div>
  );
}
