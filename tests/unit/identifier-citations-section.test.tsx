import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/server-client", () => ({ executeServerGraphQL: execute }));
import { IdentifierCitationsSection } from "@/components/people/identifier-citations-section";

const personId = "019f4df3-a656-7002-9979-8946810c5bde";
describe("Identifier citations section", () => {
  beforeEach(() => {
    execute.mockReset();
  });
  it("renders authorized source and exact field/version metadata with pagination", async () => {
    execute.mockResolvedValue({
      personIdentifierCitations: {
        nodes: [
          {
            id: "citation-1",
            identifierId: personId,
            identifierVersion: 2,
            field: "issuer",
            fieldPath: `identifiers.${personId}.v2.issuer`,
            sourceTitle: "Fictional directory",
            sourceUrl: "https://example.test/directory",
            locator: "page 7",
            quote: "A fictional public membership",
            role: "supports",
            confidence: 0.8,
            sourceReliability: 0.7,
            reviewState: "unreviewed",
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "opaque" },
      },
    });
    render(await IdentifierCitationsSection({ personId, search: {} }));
    expect(
      screen.getByRole("region", { name: "Identifier citations" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Fictional directory" }),
    ).toHaveAttribute("href", "https://example.test/directory");
    expect(screen.getByText("issuer · version 2")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Confidence: 80% · Source reliability: 70% · Review: unreviewed",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Next identifier citations page" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("identifierCitationAfter=opaque"),
    );
  });
  it("explains an empty page without claiming there are no hidden citations", async () => {
    execute.mockResolvedValue({
      personIdentifierCitations: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    render(await IdentifierCitationsSection({ personId, search: {} }));
    expect(
      screen.getByText(
        "No current public identifier citations are visible on this page.",
      ),
    ).toBeInTheDocument();
  });
  it("shows a safe accessible error without reflecting server details", async () => {
    execute.mockRejectedValue(new Error("SECRET backend detail"));
    render(await IdentifierCitationsSection({ personId, search: {} }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Identifier citations could not be loaded.",
    );
    expect(screen.queryByText(/SECRET/)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Retry identifier citations" }),
    ).toBeInTheDocument();
  });
});
