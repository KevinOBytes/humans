import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { personAddresses, personContactPoints } from "@/db/schema/evidence";
import { addresses, contactPoints, places } from "@/db/schema/locations";
import { people } from "@/db/schema/people";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type ContactPointRow = typeof contactPoints.$inferSelect;
export type PlaceRow = typeof places.$inferSelect;
export type PlaceListRow = PlaceRow & { sortKey: string };
export type AddressRow = typeof addresses.$inferSelect;
export type PersonContactRow = Readonly<{
  association: typeof personContactPoints.$inferSelect;
  contact: ContactPointRow;
}>;
export type PersonAddressRow = Readonly<{
  association: typeof personAddresses.$inferSelect;
  address: AddressRow;
  place: PlaceRow | null;
}>;

export function createLocationsRepository(database: Database) {
  return {
    async lockVisiblePerson(input: {
      id: string;
      workspaceId: string;
      visibility: SQL;
    }) {
      const [row] = await database
        .select({ id: people.id, version: people.version })
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, input.id),
            isNull(people.deletedAt),
            input.visibility,
          ),
        )
        .for("update")
        .limit(1);
      return row ?? null;
    },

    async listPersonContacts(input: {
      after: { createdAt: Date; id: string } | null;
      contactVisibility: SQL;
      limit: number;
      personId: string;
      personVisibility: SQL;
      workspaceId: string;
    }): Promise<PersonContactRow[]> {
      const rows = await database
        .select({ association: personContactPoints, contact: contactPoints })
        .from(personContactPoints)
        .innerJoin(
          contactPoints,
          and(
            eq(contactPoints.workspaceId, personContactPoints.workspaceId),
            eq(contactPoints.id, personContactPoints.contactPointId),
            isNull(contactPoints.deletedAt),
            input.contactVisibility,
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personContactPoints.workspaceId),
            eq(people.id, personContactPoints.personId),
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .where(
          and(
            eq(personContactPoints.workspaceId, input.workspaceId),
            eq(personContactPoints.personId, input.personId),
            isNull(personContactPoints.deletedAt),
            input.after
              ? or(
                  lt(personContactPoints.createdAt, input.after.createdAt),
                  and(
                    eq(personContactPoints.createdAt, input.after.createdAt),
                    sql`${personContactPoints.id} < ${input.after.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(personContactPoints.createdAt),
          desc(personContactPoints.id),
        )
        .limit(input.limit);
      return rows;
    },

    async listPersonAddresses(input: {
      addressVisibility: SQL;
      after: { createdAt: Date; id: string } | null;
      limit: number;
      personId: string;
      personVisibility: SQL;
      placeVisibility: SQL;
      workspaceId: string;
    }): Promise<PersonAddressRow[]> {
      return database
        .select({
          association: personAddresses,
          address: addresses,
          place: places,
        })
        .from(personAddresses)
        .innerJoin(
          addresses,
          and(
            eq(addresses.workspaceId, personAddresses.workspaceId),
            eq(addresses.id, personAddresses.addressId),
            isNull(addresses.deletedAt),
            input.addressVisibility,
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personAddresses.workspaceId),
            eq(people.id, personAddresses.personId),
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .leftJoin(
          places,
          and(
            eq(places.workspaceId, addresses.workspaceId),
            eq(places.id, addresses.placeId),
            isNull(places.deletedAt),
            input.placeVisibility,
          ),
        )
        .where(
          and(
            eq(personAddresses.workspaceId, input.workspaceId),
            eq(personAddresses.personId, input.personId),
            isNull(personAddresses.deletedAt),
            input.after
              ? or(
                  lt(personAddresses.createdAt, input.after.createdAt),
                  and(
                    eq(personAddresses.createdAt, input.after.createdAt),
                    sql`${personAddresses.id} < ${input.after.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(personAddresses.createdAt), desc(personAddresses.id))
        .limit(input.limit);
    },

    async listPlaces(input: {
      after: { name: string; id: string } | null;
      limit: number;
      visibility: SQL;
      workspaceId: string;
    }): Promise<PlaceListRow[]> {
      const sortKey = sql<string>`lower(${places.name} COLLATE "C") COLLATE "C"`;
      return database
        .select({ ...getTableColumns(places), sortKey })
        .from(places)
        .where(
          and(
            eq(places.workspaceId, input.workspaceId),
            isNull(places.deletedAt),
            input.visibility,
            input.after
              ? sql`(${sortKey}, ${places.id}) > (${input.after.name} COLLATE "C", ${input.after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(sortKey), asc(places.id))
        .limit(input.limit);
    },

    async getPersonContactRow(input: {
      associationId: string;
      contactVisibility: SQL;
      personVisibility: SQL;
      workspaceId: string;
      includeDeletedAssociation?: boolean;
    }): Promise<PersonContactRow | null> {
      const [row] = await database
        .select({ association: personContactPoints, contact: contactPoints })
        .from(personContactPoints)
        .innerJoin(
          contactPoints,
          and(
            eq(contactPoints.workspaceId, personContactPoints.workspaceId),
            eq(contactPoints.id, personContactPoints.contactPointId),
            isNull(contactPoints.deletedAt),
            input.contactVisibility,
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personContactPoints.workspaceId),
            eq(people.id, personContactPoints.personId),
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .where(
          and(
            eq(personContactPoints.workspaceId, input.workspaceId),
            eq(personContactPoints.id, input.associationId),
            input.includeDeletedAssociation
              ? undefined
              : isNull(personContactPoints.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getPersonAddressRow(input: {
      addressVisibility: SQL;
      associationId: string;
      personVisibility: SQL;
      placeVisibility: SQL;
      workspaceId: string;
      includeDeletedAssociation?: boolean;
    }): Promise<PersonAddressRow | null> {
      const [row] = await database
        .select({
          association: personAddresses,
          address: addresses,
          place: places,
        })
        .from(personAddresses)
        .innerJoin(
          addresses,
          and(
            eq(addresses.workspaceId, personAddresses.workspaceId),
            eq(addresses.id, personAddresses.addressId),
            isNull(addresses.deletedAt),
            input.addressVisibility,
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personAddresses.workspaceId),
            eq(people.id, personAddresses.personId),
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .leftJoin(
          places,
          and(
            eq(places.workspaceId, addresses.workspaceId),
            eq(places.id, addresses.placeId),
            isNull(places.deletedAt),
            input.placeVisibility,
          ),
        )
        .where(
          and(
            eq(personAddresses.workspaceId, input.workspaceId),
            eq(personAddresses.id, input.associationId),
            input.includeDeletedAssociation
              ? undefined
              : isNull(personAddresses.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getPlace(input: {
      id: string;
      visibility?: SQL;
      workspaceId: string;
      lock?: boolean;
    }): Promise<PlaceRow | null> {
      let query = database
        .select()
        .from(places)
        .where(
          and(
            eq(places.workspaceId, input.workspaceId),
            eq(places.id, input.id),
            isNull(places.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      if (input.lock) query = query.for("update") as typeof query;
      const [row] = await query;
      return row ?? null;
    },

    async getAddress(input: {
      id: string;
      visibility?: SQL;
      workspaceId: string;
      lock?: boolean;
    }): Promise<AddressRow | null> {
      let query = database
        .select()
        .from(addresses)
        .where(
          and(
            eq(addresses.workspaceId, input.workspaceId),
            eq(addresses.id, input.id),
            isNull(addresses.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      if (input.lock) query = query.for("update") as typeof query;
      const [row] = await query;
      return row ?? null;
    },

    async getContact(input: {
      id: string;
      visibility?: SQL;
      workspaceId: string;
      lock?: boolean;
    }): Promise<ContactPointRow | null> {
      let query = database
        .select()
        .from(contactPoints)
        .where(
          and(
            eq(contactPoints.workspaceId, input.workspaceId),
            eq(contactPoints.id, input.id),
            isNull(contactPoints.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      if (input.lock) query = query.for("update") as typeof query;
      const [row] = await query;
      return row ?? null;
    },

    async getPersonContactAssociation(input: {
      id: string;
      workspaceId: string;
      lock?: boolean;
    }) {
      let query = database
        .select()
        .from(personContactPoints)
        .where(
          and(
            eq(personContactPoints.workspaceId, input.workspaceId),
            eq(personContactPoints.id, input.id),
            isNull(personContactPoints.deletedAt),
          ),
        )
        .limit(1);
      if (input.lock) query = query.for("update") as typeof query;
      const [row] = await query;
      return row ?? null;
    },

    async getPersonAddressAssociation(input: {
      id: string;
      workspaceId: string;
      lock?: boolean;
    }) {
      let query = database
        .select()
        .from(personAddresses)
        .where(
          and(
            eq(personAddresses.workspaceId, input.workspaceId),
            eq(personAddresses.id, input.id),
            isNull(personAddresses.deletedAt),
          ),
        )
        .limit(1);
      if (input.lock) query = query.for("update") as typeof query;
      const [row] = await query;
      return row ?? null;
    },

    async clearContactPrimary(input: {
      personId: string;
      usageKind: string;
      workspaceId: string;
      exceptId?: string;
      actorId: string;
      now: Date;
    }) {
      await database
        .update(personContactPoints)
        .set({
          isPrimary: false,
          updatedAt: input.now,
          updatedBy: input.actorId,
          version: sql`${personContactPoints.version} + 1`,
        })
        .where(
          and(
            eq(personContactPoints.workspaceId, input.workspaceId),
            eq(personContactPoints.personId, input.personId),
            eq(personContactPoints.usageKind, input.usageKind),
            eq(personContactPoints.isPrimary, true),
            isNull(personContactPoints.validUntil),
            isNull(personContactPoints.deletedAt),
            input.exceptId
              ? ne(personContactPoints.id, input.exceptId)
              : undefined,
          ),
        );
    },

    async clearAddressPrimary(input: {
      personId: string;
      addressKind: string;
      workspaceId: string;
      exceptId?: string;
      actorId: string;
      now: Date;
    }) {
      await database
        .update(personAddresses)
        .set({
          isPrimary: false,
          updatedAt: input.now,
          updatedBy: input.actorId,
          version: sql`${personAddresses.version} + 1`,
        })
        .where(
          and(
            eq(personAddresses.workspaceId, input.workspaceId),
            eq(personAddresses.personId, input.personId),
            eq(personAddresses.addressKind, input.addressKind),
            eq(personAddresses.isPrimary, true),
            isNull(personAddresses.validUntil),
            isNull(personAddresses.deletedAt),
            input.exceptId ? ne(personAddresses.id, input.exceptId) : undefined,
          ),
        );
    },

    database,
  };
}
