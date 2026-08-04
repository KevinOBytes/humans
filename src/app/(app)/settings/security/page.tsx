import Link from "next/link";

import { getVerifiedAppSession } from "@/app/(app)/app-session";
import {
  DefinitionList,
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { buttonVariants } from "@/components/ui/button";
import { mapAccountSettings } from "@/modules/settings/read-model";

export default async function SecuritySettingsPage() {
  const context = await getVerifiedAppSession();
  const account = mapAccountSettings(context.session.user);
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Personal settings"
        title="Security"
        description="Security status is read from the current verified session. Credentials, recovery codes, and session tokens are never displayed here."
      />
      <SettingsCard title="Sign-in security">
        <DefinitionList
          items={[
            { label: "Email", value: account.email },
            {
              label: "Email status",
              value: account.emailVerified ? "Verified" : "Not verified",
            },
            {
              label: "Two-factor authentication",
              value: account.twoFactorEnabled ? "Enabled" : "Not enabled",
            },
          ]}
        />
        <div className="mt-5">
          <Link
            href="/two-factor/enroll"
            className={buttonVariants({ variant: "outline" })}
          >
            {account.twoFactorEnabled ? "Review 2FA status" : "Enroll in 2FA"}
          </Link>
        </div>
      </SettingsCard>
      <SettingsCard
        title="Session administration"
        description="Session revocation is withheld until a server-redacted revoke-by-ID flow has complete audit coverage."
      >
        <p className="text-muted-foreground text-sm">
          This live session is active. Raw session tokens, IP addresses, and
          user agents are not exposed.
        </p>
      </SettingsCard>
    </div>
  );
}
