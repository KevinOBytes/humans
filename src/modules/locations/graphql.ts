import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { normalizePagination } from "@/graphql/limits";
import {
  Person,
  PageInfo,
  Sensitivity,
  ValidationIssue,
} from "@/modules/people/graphql";
import type {
  MutationOutcome,
  PageInfo as PageInfoShape,
} from "@/modules/people/service";
import { EvidenceItem } from "@/modules/evidence/graphql";

import type { AddressView, ContactView } from "./service";
import type { PlaceRow } from "./repository";

const Place = builder.objectRef<PlaceRow>("Place").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID", nullable: false }),
    name: t.exposeString("name", { nullable: false }),
    kind: t.exposeString("kind", { nullable: false }),
    parentPlaceId: t.expose("parentPlaceId", { type: "UUID", nullable: true }),
    countryCode: t.exposeString("countryCode", { nullable: true }),
    region: t.exposeString("region", { nullable: true }),
    locality: t.exposeString("locality", { nullable: true }),
    latitude: t.float({
      nullable: true,
      resolve: (row) => (row.latitude == null ? null : Number(row.latitude)),
    }),
    longitude: t.float({
      nullable: true,
      resolve: (row) => (row.longitude == null ? null : Number(row.longitude)),
    }),
    sensitivity: t.field({
      type: Sensitivity,
      nullable: false,
      resolve: (row) => row.sensitivity,
    }),
    version: t.exposeInt("version", { nullable: false }),
  }),
});

const PersonContact = builder
  .objectRef<ContactView>("PersonContact")
  .implement({
    fields: (t) => ({
      associationId: t.expose("associationId", {
        type: "UUID",
        nullable: false,
      }),
      contactPointId: t.expose("contactPointId", {
        type: "UUID",
        nullable: false,
      }),
      kind: t.exposeString("kind", { nullable: false }),
      displayValue: t.exposeString("displayValue", { nullable: false }),
      label: t.exposeString("label", { nullable: true }),
      verificationState: t.exposeString("verificationState", {
        nullable: false,
      }),
      sensitivity: t.field({
        type: Sensitivity,
        nullable: false,
        resolve: (row) => row.sensitivity,
      }),
      usageKind: t.exposeString("usageKind", { nullable: false }),
      isPrimary: t.exposeBoolean("isPrimary", { nullable: false }),
      validFrom: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.validFrom?.toISOString() ?? null,
      }),
      validUntil: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.validUntil?.toISOString() ?? null,
      }),
      confidence: t.exposeFloat("confidence", { nullable: false }),
      version: t.exposeInt("version", { nullable: false }),
      contactVersion: t.exposeInt("contactVersion", { nullable: false }),
      createdAt: t.field({
        type: "DateTime",
        nullable: false,
        resolve: (row) => row.createdAt.toISOString(),
      }),
      evidence: t.field({
        type: EvidenceItem,
        nullable: true,
        complexity: 1,
        resolve: (row, _args, context) => {
          if (!row.evidenceId) return null;
          requirePermission(context, "evidence", "read");
          return context.loaders.evidenceItem.load(row.evidenceId);
        },
      }),
    }),
  });

const PersonAddress = builder
  .objectRef<AddressView>("PersonAddress")
  .implement({
    fields: (t) => ({
      associationId: t.expose("associationId", {
        type: "UUID",
        nullable: false,
      }),
      addressId: t.expose("addressId", { type: "UUID", nullable: false }),
      addressKind: t.exposeString("addressKind", { nullable: false }),
      line1: t.exposeString("line1", { nullable: true }),
      line2: t.exposeString("line2", { nullable: true }),
      locality: t.exposeString("locality", { nullable: true }),
      region: t.exposeString("region", { nullable: true }),
      postalCode: t.exposeString("postalCode", { nullable: true }),
      countryCode: t.exposeString("countryCode", { nullable: true }),
      unstructuredText: t.exposeString("unstructuredText", { nullable: true }),
      latitude: t.exposeFloat("latitude", { nullable: true }),
      longitude: t.exposeFloat("longitude", { nullable: true }),
      place: t.expose("place", { type: Place, nullable: true }),
      sensitivity: t.field({
        type: Sensitivity,
        nullable: false,
        resolve: (row) => row.sensitivity,
      }),
      isPrimary: t.exposeBoolean("isPrimary", { nullable: false }),
      validFrom: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.validFrom?.toISOString() ?? null,
      }),
      validUntil: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.validUntil?.toISOString() ?? null,
      }),
      temporalPrecision: t.exposeString("temporalPrecision", {
        nullable: false,
      }),
      confidence: t.exposeFloat("confidence", { nullable: false }),
      state: t.exposeString("state", { nullable: false }),
      version: t.exposeInt("version", { nullable: false }),
      addressVersion: t.exposeInt("addressVersion", { nullable: false }),
      createdAt: t.field({
        type: "DateTime",
        nullable: false,
        resolve: (row) => row.createdAt.toISOString(),
      }),
      evidence: t.field({
        type: EvidenceItem,
        nullable: true,
        complexity: 1,
        resolve: (row, _args, context) => {
          if (!row.evidenceId) return null;
          requirePermission(context, "evidence", "read");
          return context.loaders.evidenceItem.load(row.evidenceId);
        },
      }),
    }),
  });

const PersonContactConnection = builder
  .objectRef<{ nodes: ContactView[]; pageInfo: PageInfoShape }>(
    "PersonContactConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [PersonContact],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });
const PersonAddressConnection = builder
  .objectRef<{ nodes: AddressView[]; pageInfo: PageInfoShape }>(
    "PersonAddressConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [PersonAddress],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });
const PlaceConnection = builder
  .objectRef<{ nodes: PlaceRow[]; pageInfo: PageInfoShape }>("PlaceConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Place],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });

const ContactPayload = builder
  .objectRef<MutationOutcome<ContactView>>("ContactPayload")
  .implement({
    fields: (t) => ({
      contact: t.field({
        type: PersonContact,
        nullable: true,
        resolve: (row) => row.resource,
      }),
      issues: t.expose("issues", {
        type: [ValidationIssue],
        nullable: { items: false, list: false },
      }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });
const AddressPayload = builder
  .objectRef<MutationOutcome<AddressView>>("AddressPayload")
  .implement({
    fields: (t) => ({
      address: t.field({
        type: PersonAddress,
        nullable: true,
        resolve: (row) => row.resource,
      }),
      issues: t.expose("issues", {
        type: [ValidationIssue],
        nullable: { items: false, list: false },
      }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });
const PlacePayload = builder
  .objectRef<MutationOutcome<PlaceRow>>("PlacePayload")
  .implement({
    fields: (t) => ({
      place: t.field({
        type: Place,
        nullable: true,
        resolve: (row) => row.resource,
      }),
      issues: t.expose("issues", {
        type: [ValidationIssue],
        nullable: { items: false, list: false },
      }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });

const CreatePhoneInput = builder.inputType("CreatePhoneContactInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID", required: true }),
    value: t.string({ required: true }),
    label: t.string(),
    verificationState: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
    usageKind: t.string({ required: true }),
    isPrimary: t.boolean(),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    confidence: t.float(),
    evidenceId: t.field({ type: "UUID" }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const CreateContactInput = builder.inputType("CreatePersonContactInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID", required: true }),
    kind: t.string({ required: true }),
    value: t.string({ required: true }),
    label: t.string(),
    verificationState: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
    usageKind: t.string({ required: true }),
    isPrimary: t.boolean(),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    confidence: t.float(),
    evidenceId: t.field({ type: "UUID" }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const UpdatePhoneInput = builder.inputType("UpdatePhoneContactInput", {
  fields: (t) => ({
    associationId: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    expectedContactVersion: t.int({ required: true }),
    value: t.string(),
    label: t.string(),
    verificationState: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
    usageKind: t.string(),
    isPrimary: t.boolean(),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    confidence: t.float(),
    evidenceId: t.field({ type: "UUID" }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const ArchivePhoneInput = builder.inputType("ArchivePhoneContactInput", {
  fields: (t) => ({
    associationId: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    expectedContactVersion: t.int({ required: true }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const CreatePlaceInput = builder.inputType("CreatePlaceInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    kind: t.string({ required: true }),
    parentPlaceId: t.field({ type: "UUID" }),
    countryCode: t.string(),
    region: t.string(),
    locality: t.string(),
    latitude: t.float(),
    longitude: t.float(),
    sensitivity: t.field({ type: Sensitivity }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const UpdatePlaceInput = builder.inputType("UpdatePlaceInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    name: t.string(),
    kind: t.string(),
    parentPlaceId: t.field({ type: "UUID" }),
    countryCode: t.string(),
    region: t.string(),
    locality: t.string(),
    latitude: t.float(),
    longitude: t.float(),
    sensitivity: t.field({ type: Sensitivity }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const ArchivePlaceInput = builder.inputType("ArchivePlaceInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const CreateAddressInput = builder.inputType("CreatePersonAddressInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID", required: true }),
    addressKind: t.string({ required: true }),
    placeId: t.field({ type: "UUID" }),
    line1: t.string(),
    line2: t.string(),
    locality: t.string(),
    region: t.string(),
    postalCode: t.string(),
    countryCode: t.string(),
    unstructuredText: t.string(),
    latitude: t.float(),
    longitude: t.float(),
    sensitivity: t.field({ type: Sensitivity }),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    temporalPrecision: t.string(),
    isPrimary: t.boolean(),
    confidence: t.float(),
    state: t.string(),
    evidenceId: t.field({ type: "UUID" }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const UpdateAddressInput = builder.inputType("UpdatePersonAddressInput", {
  fields: (t) => ({
    associationId: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    expectedAddressVersion: t.int({ required: true }),
    addressKind: t.string(),
    placeId: t.field({ type: "UUID" }),
    line1: t.string(),
    line2: t.string(),
    locality: t.string(),
    region: t.string(),
    postalCode: t.string(),
    countryCode: t.string(),
    unstructuredText: t.string(),
    latitude: t.float(),
    longitude: t.float(),
    sensitivity: t.field({ type: Sensitivity }),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    temporalPrecision: t.string(),
    isPrimary: t.boolean(),
    confidence: t.float(),
    state: t.string(),
    evidenceId: t.field({ type: "UUID" }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const ArchiveAddressInput = builder.inputType("ArchivePersonAddressInput", {
  fields: (t) => ({
    associationId: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    expectedAddressVersion: t.int({ required: true }),
    idempotencyKey: t.string({ required: true }),
  }),
});

function pageComplexity(first: number | null | undefined) {
  const count = first ?? 25;
  return {
    field: 1,
    multiplier:
      Number.isInteger(count) && count > 0 && count <= 100 ? count : 101,
  };
}

export function registerLocationsGraphQL(): void {
  builder.objectFields(Person, (t) => ({
    contacts: t.field({
      type: PersonContactConnection,
      nullable: false,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => pageComplexity(args.first),
      resolve: (person, args, context) => {
        requirePermission(context, "contactPoint", "read");
        normalizePagination(args);
        return context.services.locations.listPersonContacts({
          personId: person.id,
          ...args,
        });
      },
    }),
    addresses: t.field({
      type: PersonAddressConnection,
      nullable: false,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => pageComplexity(args.first),
      resolve: (person, args, context) => {
        requirePermission(context, "address", "read");
        normalizePagination(args);
        return context.services.locations.listPersonAddresses({
          personId: person.id,
          ...args,
        });
      },
    }),
  }));

  builder.queryFields((t) => ({
    contactDisplayProjection: t.field({
      type: PersonContact,
      nullable: false,
      args: { associationId: t.arg({ type: "UUID", required: true }) },
      complexity: 2,
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "person", "read");
        return context.services.locations.getContactEditProjection(args);
      },
    }),
    addressDisplayProjection: t.field({
      type: PersonAddress,
      nullable: false,
      args: { associationId: t.arg({ type: "UUID", required: true }) },
      complexity: 2,
      resolve: (_root, args, context) => {
        requirePermission(context, "address", "read");
        requirePermission(context, "person", "read");
        return context.services.locations.getAddressEditProjection(args);
      },
    }),
    contactEditProjection: t.field({
      type: PersonContact,
      nullable: false,
      args: { associationId: t.arg({ type: "UUID", required: true }) },
      complexity: 2,
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "contactPoint", "update");
        requirePermission(context, "person", "read");
        return context.services.locations.getContactEditProjection(args);
      },
    }),
    addressEditProjection: t.field({
      type: PersonAddress,
      nullable: false,
      args: { associationId: t.arg({ type: "UUID", required: true }) },
      complexity: 2,
      resolve: (_root, args, context) => {
        requirePermission(context, "address", "read");
        requirePermission(context, "address", "update");
        requirePermission(context, "person", "read");
        return context.services.locations.getAddressEditProjection(args);
      },
    }),
    places: t.field({
      type: PlaceConnection,
      nullable: false,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => pageComplexity(args.first),
      resolve: (_root, args, context) => {
        requirePermission(context, "place", "read");
        normalizePagination(args);
        return context.services.locations.listPlaces(args);
      },
    }),
  }));

  builder.mutationFields((t) => ({
    createPhoneContact: t.field({
      type: ContactPayload,
      nullable: false,
      args: { input: t.arg({ type: CreatePhoneInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "create");
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "person", "read");
        if (args.input.evidenceId)
          requirePermission(context, "evidence", "read");
        return context.services.locations.createPhone(args.input);
      },
    }),
    createPersonContact: t.field({
      type: ContactPayload,
      nullable: false,
      args: { input: t.arg({ type: CreateContactInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "create");
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "person", "read");
        if (args.input.evidenceId)
          requirePermission(context, "evidence", "read");
        const kind = args.input.kind.toLowerCase();
        if (kind !== "phone" && kind !== "email" && kind !== "other") {
          return {
            resource: null,
            issues: [
              {
                path: ["kind"],
                code: "INVALID_ENUM",
                message: "The contact kind is invalid.",
              },
            ],
            code: "VALIDATION_FAILED" as const,
          };
        }
        return context.services.locations.createContact({
          ...args.input,
          kind,
        });
      },
    }),
    updatePhoneContact: t.field({
      type: ContactPayload,
      nullable: false,
      args: { input: t.arg({ type: UpdatePhoneInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "update");
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "person", "read");
        if (args.input.evidenceId)
          requirePermission(context, "evidence", "read");
        return context.services.locations.updatePhone(args.input);
      },
    }),
    updatePersonContact: t.field({
      type: ContactPayload,
      nullable: false,
      args: { input: t.arg({ type: UpdatePhoneInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "update");
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "person", "read");
        if (args.input.evidenceId)
          requirePermission(context, "evidence", "read");
        return context.services.locations.updateContact(args.input);
      },
    }),
    archivePhoneContact: t.field({
      type: ContactPayload,
      nullable: false,
      args: { input: t.arg({ type: ArchivePhoneInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "delete");
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "person", "read");
        return context.services.locations.archivePhone(args.input);
      },
    }),
    archivePersonContact: t.field({
      type: ContactPayload,
      nullable: false,
      args: { input: t.arg({ type: ArchivePhoneInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "contactPoint", "delete");
        requirePermission(context, "contactPoint", "read");
        requirePermission(context, "person", "read");
        return context.services.locations.archiveContact(args.input);
      },
    }),
    createPlace: t.field({
      type: PlacePayload,
      nullable: false,
      args: { input: t.arg({ type: CreatePlaceInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "place", "create");
        requirePermission(context, "place", "read");
        return context.services.locations.createPlace(args.input);
      },
    }),
    updatePlace: t.field({
      type: PlacePayload,
      nullable: false,
      args: { input: t.arg({ type: UpdatePlaceInput, required: true }) },
      resolve: async (_root, args, context) => {
        requirePermission(context, "place", "update");
        requirePermission(context, "place", "read");
        return context.services.locations.updatePlace(args.input);
      },
    }),
    archivePlace: t.field({
      type: PlacePayload,
      nullable: false,
      args: { input: t.arg({ type: ArchivePlaceInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "place", "delete");
        requirePermission(context, "place", "read");
        return context.services.locations.archivePlace(args.input);
      },
    }),
    createPersonAddress: t.field({
      type: AddressPayload,
      nullable: false,
      args: { input: t.arg({ type: CreateAddressInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "address", "create");
        requirePermission(context, "address", "read");
        requirePermission(context, "person", "read");
        if (args.input.placeId) requirePermission(context, "place", "read");
        if (args.input.evidenceId)
          requirePermission(context, "evidence", "read");
        return context.services.locations.createAddress(args.input);
      },
    }),
    updatePersonAddress: t.field({
      type: AddressPayload,
      nullable: false,
      args: { input: t.arg({ type: UpdateAddressInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "address", "update");
        requirePermission(context, "address", "read");
        requirePermission(context, "person", "read");
        if (args.input.placeId) requirePermission(context, "place", "read");
        if (args.input.evidenceId)
          requirePermission(context, "evidence", "read");
        return context.services.locations.updateAddress(args.input);
      },
    }),
    archivePersonAddress: t.field({
      type: AddressPayload,
      nullable: false,
      args: { input: t.arg({ type: ArchiveAddressInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "address", "delete");
        requirePermission(context, "address", "read");
        requirePermission(context, "person", "read");
        return context.services.locations.archiveAddress(args.input);
      },
    }),
  }));
}
