import { describe, expect, it } from "vitest";

import {
  parseCsv,
  parseExtractionContent,
} from "@/modules/files/extraction-parser";

describe("extraction parser", () => {
  it("parses bounded JSON while preserving the original text", () => {
    const parsed = parseExtractionContent({
      bytes: 24,
      contentType: "application/json",
      extractor: "text",
      text: '{"people":[{"name":"Ada"}]}',
    });
    expect(parsed.json).toEqual({ people: [{ name: "Ada" }] });
    expect(parsed.text).toContain("Ada");
  });

  it("parses quoted CSV fields and CRLF rows", () => {
    expect(parseCsv('name,note\r\nAda,"works, remotely"\r\n')).toEqual([
      ["name", "note"],
      ["Ada", "works, remotely"],
    ]);
  });

  it("rejects malformed JSON and unterminated CSV quotes", () => {
    expect(() =>
      parseExtractionContent({
        bytes: 3,
        contentType: "application/json",
        extractor: "json",
        text: "{bad",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "extraction_malformed_input" }),
    );
    expect(() => parseCsv('name,"unterminated')).toThrowError(
      expect.objectContaining({ code: "extraction_malformed_input" }),
    );
  });
});
