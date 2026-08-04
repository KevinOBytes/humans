import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseImportStream } from "@/modules/imports/parser";

async function parse(format: "CSV" | "JSON", value: string | Uint8Array) {
  const rows: Array<Record<string, unknown>> = [];
  const result = await parseImportStream({
    format,
    stream: Readable.from([value]),
    onRow: async (row) => void rows.push(row.values),
  });
  return { ...result, rows };
}

describe("strict import parser", () => {
  it("streams quoted CSV as strings with exact cardinality", async () => {
    await expect(
      parse("CSV", 'name,note\nAda,"line one\nline two"\n'),
    ).resolves.toMatchObject({
      columns: ["name", "note"],
      totalRows: 1,
      rows: [{ name: "Ada", note: "line one\nline two" }],
    });
    await expect(parse("CSV", "name,name\nAda,Lovelace\n")).rejects.toThrow(
      /duplicate/i,
    );
    await expect(parse("CSV", "a,b\n1\n")).rejects.toThrow(/column|record/i);
  });

  it("rejects Unicode-casefold duplicate keys in both formats", async () => {
    await expect(parse("CSV", "Straße,STRASSE\none,two\n")).rejects.toThrow(
      /duplicate/i,
    );
    await expect(
      parse("JSON", '[{"Straße":"one","STRASSE":"two"}]'),
    ).rejects.toThrow(/duplicate/i);
  });

  it("streams a JSON array and preserves null versus absent", async () => {
    await expect(
      parse("JSON", '[{"id":"1","name":null},{"id":"2"}]'),
    ).resolves.toMatchObject({
      columns: ["id", "name"],
      totalRows: 2,
      rows: [{ id: "1", name: null }, { id: "2" }],
    });
    await expect(parse("JSON", '[{"id":1,"id":2}]')).rejects.toThrow(
      /duplicate/i,
    );
    await expect(parse("JSON", '[{"__proto__":"x"}]')).rejects.toThrow(/key/i);
    await expect(parse("JSON", '{"id":1}')).rejects.toThrow(/array/i);
  });

  it("accepts safe JSON integers and rejects lossy integer identifiers", async () => {
    await expect(
      parse("JSON", '[{"id":9007199254740991}]'),
    ).resolves.toMatchObject({ rows: [{ id: Number.MAX_SAFE_INTEGER }] });
    await expect(parse("JSON", '[{"id":9007199254740992}]')).rejects.toThrow(
      /safe integer|precision/i,
    );
    await expect(
      parse("JSON", '[{"id":9.007199254740993e15}]'),
    ).rejects.toThrow(/safe integer|precision/i);
  });

  it("rejects invalid Unicode encodings and NUL", async () => {
    await expect(
      parse("CSV", Uint8Array.from([0xff, 0xfe, 0x61, 0x00])),
    ).rejects.toThrow(/utf/i);
    await expect(parse("JSON", '[{"id":"a\\u0000b"}]')).rejects.toThrow(/nul/i);
  });
});
