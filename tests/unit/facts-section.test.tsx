import { fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: vi.fn(),
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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

    expect(screen.getByRole("option", { name: "Grace Hopper" })).toHaveValue(
      referencedPersonId,
    );
    expect(executeServer).toHaveBeenCalledTimes(4);
    expect(String(executeServer.mock.calls[3]?.[0])).toContain("PeopleOptions");
    expect(executeServer.mock.calls[3]?.[1]).toEqual({ first: 25 });
  });

  it("lets an author page beyond 25 people and select a later reference", async () => {
    const nodes = Array.from({ length: 26 }, (_, index) => ({
      id: `person-${index + 1}`,
      displayName: `Fictional person ${index + 1}`,
    }));
    executeServer.mockImplementation(async (document, variables) => {
      if (String(document).includes("PeopleOptions")) {
        if (variables.first !== 25) throw new Error("Unbounded picker request");
        return {
          people: {
            nodes:
              variables.after === "people-cursor-25"
                ? nodes.slice(25)
                : nodes.slice(0, 25),
            pageInfo:
              variables.after === "people-cursor-25"
                ? pageInfo()
                : { hasNextPage: true, endCursor: "people-cursor-25" },
          },
        };
      }
      if (String(document).includes("PersonContradictoryFacts"))
        return baseResponses()[1];
      if (String(document).includes("FactCatalog")) return baseResponses()[2];
      return baseResponses()[0];
    });
    const props = {
      canCreate: true,
      canSelect: false,
      person: person() as never,
      personId,
    };
    const view = render(
      await FactsSection({
        ...props,
        search: { catalogAfter: "catalog-cursor", factAfter: "fact-cursor" },
      }),
    );
    const navigation = screen.getByRole("navigation", {
      name: "Person reference options pagination",
    });
    const href = within(navigation)
      .getByRole("link", { name: "More people" })
      .getAttribute("href")!;
    expect(href).toBe(
      `/people/${personId}?view=facts&factAfter=fact-cursor&catalogAfter=catalog-cursor&personReferenceAfter=people-cursor-25`,
    );
    expect(
      screen.queryByRole("option", { name: "Fictional person 26" }),
    ).not.toBeInTheDocument();
    const search = Object.fromEntries(
      new URL(href, "https://humans.example").searchParams,
    );
    view.rerender(await FactsSection({ ...props, search }));
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "person-26" },
    });
    expect(screen.getByLabelText("Value")).toHaveValue("person-26");
    expect(
      screen.queryByRole("link", { name: "More people" }),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("navigation", {
          name: "Person reference options pagination",
        }),
      ).getByRole("link", { name: "First page" }),
    ).toHaveAttribute(
      "href",
      `/people/${personId}?view=facts&factAfter=fact-cursor&catalogAfter=catalog-cursor`,
    );
  });

  it("ignores malformed reference cursors rather than forwarding them to GraphQL", async () => {
    executeServer
      .mockResolvedValueOnce(baseResponses()[0])
      .mockResolvedValueOnce(baseResponses()[1])
      .mockResolvedValueOnce(baseResponses()[2])
      .mockResolvedValueOnce({
        people: {
          nodes: [{ id: referencedPersonId, displayName: "Grace Hopper" }],
          pageInfo: pageInfo(),
        },
      });
    render(
      await FactsSection({
        canCreate: true,
        canSelect: false,
        person: person() as never,
        personId,
        search: { personReferenceAfter: "invalid/cursor?secret=value" },
      }),
    );
    expect(executeServer.mock.calls[3]?.[1]).toEqual({
      first: 25,
      after: undefined,
    });
    expect(
      screen.queryByRole("navigation", {
        name: "Person reference options pagination",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Grace Hopper" })).toHaveValue(
      referencedPersonId,
    );
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
