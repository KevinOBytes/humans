import { and, eq, isNull } from "drizzle-orm";
import { people, personIdentifiers } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { parseIdentifierCitationPath } from "./assertions-validation";

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
          resourceKind: "person_identifier",
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
  // Assertions contain plaintext quotes/locators. Protected identifiers must not
  // acquire a less protected shadow copy through a person-level assertion.
  if (identifier.sensitivity !== "public")
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Protected identifier citations require protected evidence storage.",
    );
  if (requireCurrentVersion && identifier.version !== citation.version)
    throw createGraphQLError(
      "CONFLICT",
      "The identifier has changed. Refresh before citing it.",
    );
}
