import { describe, expect, it } from "vitest";

import { parseImportMapping, projectImportRow } from "@/modules/imports/mapper";

const definitionId = "01900000-0000-7000-8000-000000000001";
const firstPersonImportId = "01900000-0000-7000-8000-000000000002";
const secondPersonImportId = "01900000-0000-7000-8000-000000000003";

describe("closed import mappings", () => {
  it("maps one PERSON operation deterministically", () => {
    const mapping = parseImportMapping(
      {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "external_id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [{ field: "biography", source: "bio" }],
        },
        facts: [{ definitionId, source: "birth_date" }],
        defaults: { sensitivity: "internal", status: "active" },
      },
      ["external_id", "name", "bio", "birth_date"],
    );
    expect(
      projectImportRow(mapping, {
        external_id: " p-1 ",
        name: " Ada Lovelace ",
        bio: " mathematician ",
        birth_date: "1815-12-10",
      }),
    ).toMatchObject({
      kind: "PERSON",
      rowKey: "p-1",
      person: { displayName: "Ada Lovelace", biography: "mathematician" },
      facts: [{ definitionId, value: "1815-12-10" }],
    });
  });

  it("preserves structured, numeric, and boolean fact values", () => {
    const mapping = parseImportMapping(
      {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [],
        },
        facts: [
          { definitionId, source: "structured" },
          { definitionId: firstPersonImportId, source: "count" },
          { definitionId: secondPersonImportId, source: "active" },
        ],
        defaults: {},
      },
      ["id", "name", "structured", "count", "active"],
    );
    expect(
      projectImportRow(mapping, {
        id: "person-1",
        name: "Ada",
        structured: { nested: ["value"] },
        count: 0,
        active: false,
      }),
    ).toMatchObject({
      facts: [
        { definitionId, value: { nested: ["value"] } },
        { definitionId: firstPersonImportId, value: 0 },
        { definitionId: secondPersonImportId, value: false },
      ],
    });
  });

  it("rejects unknown columns, dynamic paths, and mixed operation shapes", () => {
    expect(() =>
      parseImportMapping(
        {
          version: 1,
          recordKind: "PERSON",
          rowKeySource: "id",
          person: {
            displayNameSource: "missing",
            primaryNameKind: "legal",
            fields: [],
          },
          facts: [],
          relationship: {
            typeId: definitionId,
            sourcePersonIdSource: "id",
            targetPersonIdSource: "id",
            fields: [],
          },
          defaults: {},
        },
        ["id"],
      ),
    ).toThrow(/mapping|column/i);
  });

  it("projects independently typed relationship endpoints without guessing", () => {
    const mapping = parseImportMapping(
      {
        version: 1,
        recordKind: "RELATIONSHIP",
        rowKeySource: "edge_id",
        relationship: {
          typeId: definitionId,
          sourcePerson: { kind: "PERSON_ID", source: "source_uuid" },
          targetPerson: {
            kind: "EXTERNAL_KEY",
            personImportId: secondPersonImportId,
            source: "target_key",
          },
          fields: [{ field: "labelOverride", source: "label" }],
        },
        defaults: { sensitivity: "internal", state: "asserted" },
      },
      ["edge_id", "source_uuid", "target_key", "label"],
    );
    expect(
      projectImportRow(mapping, {
        edge_id: "edge-1",
        source_uuid: firstPersonImportId.toUpperCase(),
        target_key: "target-001",
        label: "worked with",
      }),
    ).toEqual({
      kind: "RELATIONSHIP",
      rowKey: "edge-1",
      relationship: {
        typeId: definitionId,
        sourcePerson: {
          kind: "PERSON_ID",
          personId: firstPersonImportId,
        },
        targetPerson: {
          kind: "EXTERNAL_KEY",
          personImportId: secondPersonImportId,
          externalId: "target-001",
        },
        labelOverride: "worked with",
      },
      defaults: { sensitivity: "internal", state: "asserted" },
    });
  });

  it("rejects the old ambiguous relationship shape and invalid endpoint values", () => {
    expect(() =>
      parseImportMapping(
        {
          version: 1,
          recordKind: "RELATIONSHIP",
          rowKeySource: "edge_id",
          relationship: {
            typeId: definitionId,
            sourcePersonIdSource: "source",
            targetPersonIdSource: "target",
            fields: [],
          },
          defaults: {},
        },
        ["edge_id", "source", "target"],
      ),
    ).toThrow(/mapping/i);

    const mapping = parseImportMapping(
      {
        version: 1,
        recordKind: "RELATIONSHIP",
        rowKeySource: "edge_id",
        relationship: {
          typeId: definitionId,
          sourcePerson: { kind: "PERSON_ID", source: "source" },
          targetPerson: {
            kind: "EXTERNAL_KEY",
            personImportId: secondPersonImportId,
            source: "target",
          },
          fields: [],
        },
        defaults: {},
      },
      ["edge_id", "source", "target"],
    );
    expect(() =>
      projectImportRow(mapping, {
        edge_id: "edge-2",
        source: "not-a-uuid",
        target: "target-002",
      }),
    ).toThrow(/UUID/i);
    expect(() =>
      projectImportRow(mapping, {
        edge_id: "edge-3",
        source: firstPersonImportId,
        target: "a".repeat(513),
      }),
    ).toThrow(/external key/i);
  });
});
