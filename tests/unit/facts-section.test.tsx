import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeServer = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/server-client", () => ({
  executeServerGraphQL: executeServer,
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));
vi.mock("@/lib/verified-field-selections", () => ({
  readVerifiedFieldSelections: vi.fn(async () => ({
    byField: new Map(),
    verified: true,
  })),
}));
vi.mock("@/components/facts/fact-form", () => ({
  FactForm: (props: { personOptions?: readonly { id: string }[] }) => (
    <div
      data-testid="fact-form"
      data-person-options={props.personOptions
        ?.map((person) => person.id)
        .join(",")}
    />
  ),
  FactSelectionButton: () => null,
}));
vi.mock("@/components/facts/fact-display-value", () => ({
  factDisplayValue: () => "fact value",
}));
vi.mock("@/components/people/person-profile", () => ({
  PersonProfile: (props: {
    person: {
      facts: readonly {
        evidence: readonly {
          id: string;
          supportStrength?: number | null;
        }[];
      }[];
    };
  }) => (
    <div data-testid="person-profile">
      {props.person.facts.flatMap((fact) =>
        fact.evidence.map((evidence) => (
          <span key={evidence.id}>{evidence.supportStrength}</span>
        )),
      )}
    </div>
  ),
}));
vi.mock("@/components/research/paginated-research-list", () => ({
  PageControls: () => null,
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));

import { FactsSection } from "@/components/facts/facts-section";

const personId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d0";
const referencedPersonId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d1";

function pageInfo() {
  return { endCursor: null, hasNextPage: false };
}

function person() {
  return {
    biography: null,
    confidence: 0.5,
    confidenceExplanation: null,
    displayName: "Ada Lovelace",
    facts: { nodes: [], pageInfo: pageInfo() },
    id: personId,
    mergedIntoPersonId: null,
    preferredName: null,
    primaryNameId: null,
    primaryPhotoFileId: null,
    sensitivity: "INTERNAL",
    sortName: "Lovelace, Ada",
    status: "ACTIVE",
    version: 1,
  };
}

function baseResponses() {
  return [
    { person: person() },
    { person: { contradictoryFacts: { nodes: [], pageInfo: pageInfo() } } },
    {
      factDefinitions: {
        nodes: [
          {
            allowedValueType: "PERSON_REFERENCE",
            defaultSensitivity: "INTERNAL",
            id: "definition-related-person",
            label: "Related person",
          },
        ],
        pageInfo: pageInfo(),
      },
    },
  ];
}

describe("FactsSection", () => {
  beforeEach(() => executeServer.mockReset());

  it("loads workspace-scoped people only when the catalog needs a reference picker", async () => {
    executeServer
      .mockResolvedValueOnce(baseResponses()[0])
      .mockResolvedValueOnce(baseResponses()[1])
      .mockResolvedValueOnce(baseResponses()[2])
      .mockResolvedValueOnce({
        people: {
          nodes: [{ displayName: "Grace Hopper", id: referencedPersonId }],
          pageInfo: pageInfo(),
        },
      });

    render(
      await FactsSection({
        canCreate: true,
        canSelect: false,
        person: person() as never,
        personId,
        search: {},
      }),
    );

    expect(screen.getByTestId("fact-form")).toHaveAttribute(
      "data-person-options",
      referencedPersonId,
    );
    expect(executeServer).toHaveBeenCalledTimes(4);
    expect(String(executeServer.mock.calls[3]?.[0])).toContain("PeopleOptions");
  });

  it("carries authorized citation strength from generated fact detail into the profile", async () => {
    executeServer
      .mockResolvedValueOnce({
        person: {
          ...person(),
          facts: {
            nodes: [
              {
                id: "fact-a",
                namespace: "person",
                fieldKey: "date_of_birth",
                label: "Date of birth",
                sensitivity: "PUBLIC",
                state: "ASSERTED",
                version: 1,
                value: { dateStart: "1815-12-10" },
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      })
      .mockResolvedValueOnce({
        person: { contradictoryFacts: { nodes: [], pageInfo: pageInfo() } },
      })
      .mockResolvedValueOnce({
        fact: {
          id: "fact-a",
          revisions: { nodes: [], pageInfo: pageInfo() },
          evidence: {
            nodes: [
              {
                id: "fact-evidence-a",
                excerpt: "Conflicting register entry",
                locator: "page 42",
                supportStrength: -0.75,
                evidenceItem: {
                  source: {
                    title: "Archive register",
                    canonicalUrl: null,
                  },
                },
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      });

    render(
      await FactsSection({
        canCreate: false,
        canSelect: false,
        person: person() as never,
        personId,
        search: {},
      }),
    );

    expect(screen.getByText("-0.75")).toBeVisible();
    expect(executeServer).toHaveBeenCalledTimes(3);
    expect(String(executeServer.mock.calls[2]?.[0])).toContain("FactDetail");
  });
});
