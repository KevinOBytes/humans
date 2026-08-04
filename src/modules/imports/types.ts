export type ImportFormat = "CSV" | "JSON";

export type ImportScalar = string | number | boolean | null;
export type ImportValue =
  | ImportScalar
  | readonly ImportValue[]
  | { readonly [key: string]: ImportValue };
export type ParsedImportRow = {
  rowNumber: number;
  values: Record<string, ImportValue>;
  warnings: readonly string[];
};

export type StoredImportMapping = {
  definition: ImportMapping;
  fileChecksum?: string;
  fileSize?: number;
  mappingHash: string;
  mappingId: string;
  mappingVersion: number;
  mode: "COMMIT" | "DRY_RUN";
  requestHash: string;
};

export type PersonImportMapping = {
  version: 1;
  recordKind: "PERSON";
  rowKeySource: string;
  person: {
    displayNameSource: string;
    primaryNameKind:
      | "legal"
      | "preferred"
      | "birth"
      | "married"
      | "former"
      | "alias"
      | "transliteration"
      | "other";
    fields: readonly {
      field: "biography" | "preferredName" | "sortName";
      source: string;
    }[];
  };
  facts: readonly { definitionId: string; source: string }[];
  defaults: {
    sensitivity?: "public" | "internal" | "confidential" | "restricted";
    status?: "active" | "deceased" | "missing" | "unknown";
  };
};

export type RelationshipEndpointMapping =
  | { kind: "PERSON_ID"; source: string }
  | { kind: "EXTERNAL_KEY"; personImportId: string; source: string };

export type RelationshipImportMapping = {
  version: 1;
  recordKind: "RELATIONSHIP";
  rowKeySource: string;
  relationship: {
    typeId: string;
    sourcePerson: RelationshipEndpointMapping;
    targetPerson: RelationshipEndpointMapping;
    fields: readonly { field: "labelOverride"; source: string }[];
  };
  defaults: {
    sensitivity?: "public" | "internal" | "confidential" | "restricted";
    state?: "asserted" | "disputed" | "disproven" | "superseded";
  };
};

export type ImportMapping = PersonImportMapping | RelationshipImportMapping;
