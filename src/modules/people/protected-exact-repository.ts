import "server-only";

import { and, asc, eq, gt, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import { personContactPoints } from "@/db/schema/evidence";
import { contactPoints } from "@/db/schema/locations";
import { people, personIdentifiers } from "@/db/schema/people";
import type { Database } from "@/modules/auth/bootstrap-admin";

type LookupInput = {
  afterPersonId: string | null;
  blindIndex: string;
  limit: number;
  personVisibility: SQL;
  protectedVisibility: SQL;
  workspaceId: string;
};

export function createProtectedExactRepository(database: Database) {
  return {
    lookupPhones(input: LookupInput) {
      return database
        .selectDistinct({ personId: people.id })
        .from(contactPoints)
        .innerJoin(
          personContactPoints,
          and(
            eq(personContactPoints.workspaceId, contactPoints.workspaceId),
            eq(personContactPoints.contactPointId, contactPoints.id),
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personContactPoints.workspaceId),
            eq(people.id, personContactPoints.personId),
          ),
        )
        .where(
          and(
            eq(contactPoints.workspaceId, input.workspaceId),
            eq(personContactPoints.workspaceId, input.workspaceId),
            eq(people.workspaceId, input.workspaceId),
            eq(contactPoints.kind, "phone"),
            eq(contactPoints.blindIndexVersion, 1),
            eq(contactPoints.blindIndex, input.blindIndex),
            isNull(contactPoints.deletedAt),
            isNull(personContactPoints.deletedAt),
            isNull(people.deletedAt),
            or(
              isNull(personContactPoints.validFrom),
              sql`${personContactPoints.validFrom} <= clock_timestamp()`,
            ),
            or(
              isNull(personContactPoints.validUntil),
              sql`${personContactPoints.validUntil} >= clock_timestamp()`,
            ),
            input.protectedVisibility,
            input.personVisibility,
            input.afterPersonId
              ? gt(people.id, input.afterPersonId)
              : undefined,
          ),
        )
        .orderBy(asc(people.id))
        .limit(input.limit);
    },

    lookupPersonIdentifiers(input: LookupInput & { namespace: string }) {
      return database
        .selectDistinct({ personId: people.id })
        .from(personIdentifiers)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personIdentifiers.workspaceId),
            eq(people.id, personIdentifiers.personId),
          ),
        )
        .where(
          and(
            eq(personIdentifiers.workspaceId, input.workspaceId),
            eq(people.workspaceId, input.workspaceId),
            eq(personIdentifiers.namespace, input.namespace),
            eq(personIdentifiers.blindIndexVersion, 1),
            eq(personIdentifiers.blindIndex, input.blindIndex),
            ne(personIdentifiers.verificationState, "revoked"),
            isNull(personIdentifiers.deletedAt),
            isNull(people.deletedAt),
            or(
              isNull(personIdentifiers.validFrom),
              sql`${personIdentifiers.validFrom} <= clock_timestamp()`,
            ),
            or(
              isNull(personIdentifiers.validUntil),
              sql`${personIdentifiers.validUntil} >= clock_timestamp()`,
            ),
            input.protectedVisibility,
            input.personVisibility,
            input.afterPersonId
              ? gt(people.id, input.afterPersonId)
              : undefined,
          ),
        )
        .orderBy(asc(people.id))
        .limit(input.limit);
    },
  };
}
