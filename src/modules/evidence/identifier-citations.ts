import { and, eq, ilike, isNull } from "drizzle-orm";
import { evidenceAssertions } from "@/db/schema/evidence";
import { people, personIdentifiers } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { parseIdentifierCitationPath } from "./assertions-validation";

export const PROTECTED_CITATION_LOCATOR_PURPOSE =
  "protected-identifier-citation-locator";
export const PROTECTED_CITATION_QUOTE_PURPOSE =
  "protected-identifier-citation-quote";

function protectedCitationKey(context: ResearchServiceContext): string {
  const key = context.protectedExactRuntime?.encryptionKey;
  if (!key || !/^[0-9a-f]{64}$/iu.test(key))
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Protected citation storage is not configured.",
    );
  return key;
}

export function sealProtectedIdentifierCitation(
  context: ResearchServiceContext,
  input: { locator: string; quote: string },
) {
  const key = protectedCitationKey(context);
  return {
    encryptedLocator: sealEnvelope({
      key,
      plaintext: input.locator,
      purpose: PROTECTED_CITATION_LOCATOR_PURPOSE,
    }),
    encryptedQuote: sealEnvelope({
      key,
      plaintext: input.quote,
      purpose: PROTECTED_CITATION_QUOTE_PURPOSE,
    }),
  };
}

export function openProtectedIdentifierCitation<
  T extends {
    locator: string | null;
    quote: string | null;
    encryptedLocator: string | null;
    encryptedQuote: string | null;
  },
>(
  context: ResearchServiceContext,
  row: T,
): T & { locator: string; quote: string } {
  if (row.locator !== null && row.quote !== null)
    return row as T & { locator: string; quote: string };
  if (!row.encryptedLocator || !row.encryptedQuote)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Protected citation storage is invalid.",
    );
  try {
    const key = protectedCitationKey(context);
    return {
      ...row,
      locator: openSealedEnvelope({
        key,
        purpose: PROTECTED_CITATION_LOCATOR_PURPOSE,
        token: row.encryptedLocator,
      }),
      quote: openSealedEnvelope({
        key,
        purpose: PROTECTED_CITATION_QUOTE_PURPOSE,
        token: row.encryptedQuote,
      }),
    };
  } catch {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Protected citation cannot be disclosed.",
    );
  }
}

export function assertIdentifierCitationStorage(
  sensitivity: string,
  row: {
    locator: string | null;
    quote: string | null;
    encryptedLocator: string | null;
    encryptedQuote: string | null;
  },
) {
  const plaintext = row.locator !== null && row.quote !== null;
  const encrypted =
    row.encryptedLocator !== null && row.encryptedQuote !== null;
  if (
    (sensitivity === "public" && !plaintext) ||
    (sensitivity !== "public" && !encrypted)
  )
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Protected citation storage is invalid.",
    );
}

/** Call within the assertion transaction; parent-first locking matches identifier writes/merges. */
export async function requireIdentifierCitation(
  context: ResearchServiceContext,
  input: { resourceKind: string; resourceId: string; fieldPath: string | null },
  requireCurrentVersion: boolean,
) {
  const citation = parseIdentifierCitationPath(
    input.resourceKind,
    input.fieldPath,
  );
  if (!citation) return;
  const [parent] = await context.database
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspaceId, context.workspaceId),
        eq(people.id, input.resourceId),
        isNull(people.deletedAt),
        resourceVisibilitySql(context, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        }),
      ),
    )
    .limit(1)
    .for("share");
  if (!parent)
    throw createGraphQLError(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  // Never select, decrypt, or copy the identifier value into the citation.
  const [identifier] = await context.database
    .select({
      version: personIdentifiers.version,
      sensitivity: personIdentifiers.sensitivity,
    })
    .from(personIdentifiers)
    .where(
      and(
        eq(personIdentifiers.workspaceId, context.workspaceId),
        eq(personIdentifiers.id, citation.identifierId),
        eq(personIdentifiers.personId, parent.id),
        isNull(personIdentifiers.deletedAt),
        resourceVisibilitySql(context, {
          resourceKind: "personIdentifier",
          id: personIdentifiers.id,
          sensitivity: personIdentifiers.sensitivity,
        }),
      ),
    )
    .limit(1)
    .for("share");
  if (!identifier)
    throw createGraphQLError(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  // The caller chooses the storage mode after this current-version and
  // visibility check; protected values must not acquire a plaintext shadow.
  if (requireCurrentVersion && identifier.version !== citation.version)
    throw createGraphQLError(
      "CONFLICT",
      "The identifier has changed. Refresh before citing it.",
    );
  return identifier;
}

/** The caller holds the identifier's parent write lock, excluding new citations. */
export async function requireUncitedIdentifierReclassification(
  context: ResearchServiceContext,
  identifierId: string,
) {
  const [assertion] = await context.database
    .select({ id: evidenceAssertions.id })
    .from(evidenceAssertions)
    .where(
      and(
        eq(evidenceAssertions.workspaceId, context.workspaceId),
        isNull(evidenceAssertions.deletedAt),
        // Check every parent/version, including pre-canonical paths: merges must
        // not hide an existing plaintext quote associated with this identifier.
        ilike(evidenceAssertions.fieldPath, `identifiers.${identifierId}%`),
      ),
    )
    .limit(1)
    .for("share");
  if (assertion)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "An identifier with active plaintext citations cannot be reclassified as protected.",
    );
}
