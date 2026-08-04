import Link from "next/link";

import { getAdministrativeSettingsContext } from "@/app/(app)/settings/settings-context";
import {
  ReadOnlyAdministrationNotice,
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-surface";
import { Badge } from "@/components/ui/badge";
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
        description="Redacted organization-key metadata from a generated, live-authorized, workspace-scoped safe projection that paginates beyond Better Auth 1.6.23's 100-row cap. Stored keys and hashes are never selected."
      />
      <ReadOnlyAdministrationNotice />
      <SettingsCard title="Organization keys">
        <ul className="grid gap-3">
          {apiKeyPage.nodes.map((apiKey) => (
            <li
              key={`${apiKey.fingerprint}:${apiKey.createdAt}`}
              className="border-border rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{apiKey.name}</p>
                  <p className="text-muted-foreground mt-1 font-mono text-xs">
                    {apiKey.fingerprint}
                  </p>
                </div>
                <Badge>{apiKey.state}</Badge>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Scopes</dt>
                  <dd className="mt-1 break-words">
                    {apiKey.scopes.join(", ") || "None"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd className="mt-1">
                    {apiKey.expiresAt
                      ? new Date(apiKey.expiresAt).toLocaleString()
                      : "No expiry recorded"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last used</dt>
                  <dd className="mt-1">
                    {apiKey.lastUsedAt
                      ? new Date(apiKey.lastUsedAt).toLocaleString()
                      : "Never"}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
          {apiKeyPage.nodes.length === 0 ? (
            <li className="text-muted-foreground py-5 text-sm">
              No organization API keys are recorded.
            </li>
          ) : null}
        </ul>
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
