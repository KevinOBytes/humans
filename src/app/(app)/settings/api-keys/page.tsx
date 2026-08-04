import Link from "next/link";

import { getAdministrativeSettingsContext } from "@/app/(app)/settings/settings-context";
import { ApiKeyAdministration } from "@/components/settings/api-key-administration";
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { buttonVariants } from "@/components/ui/button";
import { SettingsOrganizationApiKeysDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { readSettingsOffset } from "@/modules/settings/pagination";

export default async function ApiKeysSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await getAdministrativeSettingsContext();
  const offset = readSettingsOffset((await searchParams).offset);
  const data = await executeServerGraphQL(SettingsOrganizationApiKeysDocument, {
    offset,
  });
  const apiKeyPage = data.settingsOrganizationApiKeys;
  return (
    <div className="space-y-6">
      <SettingsHeader
        eyebrow="Workspace settings"
        title="API keys"
        description="Create least-privilege workspace API keys, save the one-time secret, and rotate or revoke keys from a redacted, workspace-scoped settings surface."
      />
      <SettingsCard
        title="Organization keys"
        description="Stored keys, hashes, and organization identifiers never appear here."
      >
        <ApiKeyAdministration
          apiKeys={apiKeyPage.nodes}
          allowedScopes={apiKeyPage.allowedScopes}
        />
        <nav
          aria-label="API key pages"
          className="mt-4 flex flex-wrap items-center justify-between gap-3"
        >
          <p className="text-muted-foreground text-sm">
            {apiKeyPage.nodes.length === 0
              ? `Showing 0 of ${apiKeyPage.total}`
              : `Showing ${apiKeyPage.offset + 1}–${apiKeyPage.offset + apiKeyPage.nodes.length} of ${apiKeyPage.total}`}
          </p>
          <div className="flex gap-2">
            {apiKeyPage.hasPrevious ? (
              <Link
                href={
                  apiKeyPage.offset === apiKeyPage.limit
                    ? "/settings/api-keys"
                    : `/settings/api-keys?offset=${apiKeyPage.offset - apiKeyPage.limit}`
                }
                className={buttonVariants({ variant: "outline" })}
              >
                Previous API keys
              </Link>
            ) : null}
            {apiKeyPage.hasMore ? (
              <Link
                href={`/settings/api-keys?offset=${apiKeyPage.offset + apiKeyPage.limit}`}
                className={buttonVariants({ variant: "outline" })}
              >
                Next API keys
              </Link>
            ) : null}
          </div>
        </nav>
      </SettingsCard>
    </div>
  );
}
