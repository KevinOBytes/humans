import "server-only";

import { contactPoints } from "@/db/schema/locations";
import { people, personIdentifiers } from "@/db/schema/people";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import {
  deriveProtectedExactBlindIndexV1,
  type ProtectedExactInput,
} from "@/lib/security/protected-exact";
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";

import { createProtectedExactRepository } from "./protected-exact-repository";

export type ProtectedExactLookupPage = Readonly<{
  nodes: readonly Readonly<{
    kind: "PHONE" | "PERSON_IDENTIFIER";
    personId: string;
  }>[];
  nextPersonId: string | null;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function forbidden(): never {
  throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
}

function invalid(): never {
  throw createGraphQLError(
    "VALIDATION_FAILED",
    publicErrorMessage("VALIDATION_FAILED"),
  );
}

export function createProtectedExactLookupService(
  context: ResearchServiceContext,
  runtime: { blindIndexKey: string },
) {
  const repository = createProtectedExactRepository(context.database);
  const personVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: people.id,
    sensitivity: people.sensitivity,
  });
  const contactVisibility = resourceVisibilitySql(context, {
    resourceKind: "contactPoint",
    id: contactPoints.id,
    sensitivity: contactPoints.sensitivity,
  });
  const identifierVisibility = resourceVisibilitySql(context, {
    resourceKind: "personIdentifier",
    id: personIdentifiers.id,
    sensitivity: personIdentifiers.sensitivity,
  });

  return {
    async lookup(input: {
      afterPersonId?: string | null;
      first: number;
      lookup: ProtectedExactInput;
    }): Promise<ProtectedExactLookupPage> {
      if (
        !context.permissions.has("search:read") ||
        !context.permissions.has("person:read")
      ) {
        return forbidden();
      }
      if (
        !input ||
        !Number.isInteger(input.first) ||
        input.first < 1 ||
        input.first > 100 ||
        (input.afterPersonId != null && !UUID.test(input.afterPersonId))
      ) {
        return invalid();
      }
      let prepared;
      try {
        prepared = deriveProtectedExactBlindIndexV1({
          blindIndexKey: runtime.blindIndexKey,
          lookup: input.lookup,
          workspaceId: context.workspaceId,
        });
      } catch (error) {
        if (error instanceof TypeError) return invalid();
        throw error;
      }
      const common = {
        afterPersonId: input.afterPersonId ?? null,
        blindIndex: prepared.blindIndex,
        limit: input.first + 1,
        personVisibility,
        workspaceId: context.workspaceId,
      };
      const rows =
        input.lookup.kind === "PHONE"
          ? await repository.lookupPhones({
              ...common,
              protectedVisibility: contactVisibility,
            })
          : await repository.lookupPersonIdentifiers({
              ...common,
              namespace: prepared.namespace!,
              protectedVisibility: identifierVisibility,
            });
      const returned = rows.slice(0, input.first);
      return Object.freeze({
        nodes: Object.freeze(
          returned.map(({ personId }) =>
            Object.freeze({ kind: input.lookup.kind, personId }),
          ),
        ),
        nextPersonId:
          rows.length > input.first
            ? (returned.at(-1)?.personId ?? null)
            : null,
      });
    },
  };
}
