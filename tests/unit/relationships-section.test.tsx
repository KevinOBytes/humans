import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeServer = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/server-client", () => ({
  executeServerGraphQL: executeServer,
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));
vi.mock("@/components/relationships/relationship-form", () => ({
  RelationshipForm: () => null,
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { RelationshipsSection } from "@/components/relationships/relationships-section";

const personId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d0";
const counterpartId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d1";
const relationshipTypeId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d2";

function relationship(
  id: string,
  evidence: {
    nodes: Array<{
      id: string;
      locator: string | null;
      evidenceItem: {
        id: string;
        reviewState: string;
        source: {
          id: string;
          title: string;
          citation: string | null;
        } | null;
      } | null;
    }>;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  },
) {
  return {
    id,
    relationshipTypeId,
    sourcePersonId: personId,
    targetPersonId: counterpartId,
    labelOverride: null,
    state: "ASSERTED",
    sensitivity: "INTERNAL",
    confidence: 0.85,
    strength: 0.7,
    temporalSemantics: "ONGOING",
    temporalPrecision: "DAY",
    validFrom: "2024-01-01T00:00:00.000Z",
    validUntil: null,
    observedAt: "2024-02-01T00:00:00.000Z",
    creationMethod: "MANUAL",
    reviewState: "APPROVED",
    version: 1,
    createdAt: "2024-02-01T00:00:00.000Z",
    updatedAt: "2024-02-01T00:00:00.000Z",
    evidence,
  };
}

describe("RelationshipsSection", () => {
  beforeEach(() => executeServer.mockReset());

  it("shows compact provenance and an explicit empty state on relationship cards", async () => {
    executeServer
      .mockResolvedValueOnce({
        person: {
          id: personId,
          relationships: {
            nodes: [
              relationship("018f5f39-9ca7-7b67-a2f1-b8a82ca894d3", {
                nodes: [
                  {
                    id: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d4",
                    locator: "page 14",
                    evidenceItem: {
                      id: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d5",
                      reviewState: "accepted",
                      source: {
                        id: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d6",
                        title: "Published interview",
                        citation: "Interview transcript, 2024",
                      },
                    },
                  },
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              }),
              relationship("018f5f39-9ca7-7b67-a2f1-b8a82ca894d7", {
                nodes: [],
                pageInfo: { endCursor: null, hasNextPage: false },
              }),
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      })
      .mockResolvedValueOnce({
        relationshipType: {
          id: relationshipTypeId,
          key: "collaborated_with",
          forwardLabel: "collaborated with",
          inverseLabel: "collaborated with",
          directed: true,
        },
      })
      .mockResolvedValueOnce({
        person: { id: counterpartId, displayName: "Grace Hopper" },
      });

    render(
      await RelationshipsSection({
        canCreate: false,
        personId,
        search: {},
      }),
    );

    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("Published interview")).toBeVisible();
    expect(
      within(cards[0]!).getByText("Interview transcript, 2024"),
    ).toBeVisible();
    expect(within(cards[0]!).getByText("page 14")).toBeVisible();
    expect(within(cards[0]!).getByText("accepted")).toBeVisible();
    expect(within(cards[1]!).getByText("No evidence linked.")).toBeVisible();
  });
});
