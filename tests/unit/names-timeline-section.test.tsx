import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeServer = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/server-client", () => ({
  executeServerGraphQL: executeServer,
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
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

import { NamesTimelineSection } from "@/components/people/names-timeline-section";

const personId = "018f5f39-9ca7-7b67-a2f1-b8a82ca894d0";
const nameAfter = `names-${"a".repeat(64)}`;
const eventAfter = `events-${"b".repeat(64)}`;
const nextNameCursor = `next-names-${"c".repeat(64)}`;
const nextEventCursor = `next-events-${"d".repeat(64)}`;

function pageInfo(endCursor: string) {
  return { hasNextPage: true, endCursor };
}

function response() {
  return {
    person: {
      names: {
        nodes: [
          {
            id: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d1",
            fullName: "Ada Byron",
            givenName: "Ada",
            middleName: null,
            familyName: "Byron",
            kind: "ALIAS",
            state: "ASSERTED",
            validFrom: "1815-12-10",
            validUntil: null,
          },
        ],
        pageInfo: pageInfo(nextNameCursor),
      },
      events: {
        nodes: [
          {
            id: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d2",
            title: "Published first program",
            eventKind: "MILESTONE",
            description: "Timeline acceptance event.",
            earliestAt: "1843-01-01T00:00:00.000Z",
            latestAt: null,
            state: "DISPUTED",
          },
        ],
        pageInfo: pageInfo(nextEventCursor),
      },
    },
  };
}

describe("NamesTimelineSection", () => {
  beforeEach(() => {
    executeServer.mockReset();
  });

  it("keeps names and timeline as independent semantic sections", async () => {
    executeServer
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());

    render(
      await NamesTimelineSection({
        personId,
        search: {},
      }),
    );

    expect(screen.getByRole("heading", { name: "Names" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Timeline" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ada Byron" })).toBeVisible();
    expect(
      screen.getByText("Published first program", { exact: true }),
    ).toBeVisible();
    expect(screen.getByText("disputed", { exact: true })).toBeVisible();
    expect(screen.getByText("Timeline acceptance event.")).toBeVisible();
  });

  it("preserves each pagination cursor while advancing the other list", async () => {
    executeServer
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());

    render(
      await NamesTimelineSection({
        personId,
        search: { nameAfter, eventAfter },
      }),
    );

    expect(screen.getByRole("link", { name: "More names" })).toHaveAttribute(
      "href",
      `/people/${personId}?view=names&nameAfter=${nextNameCursor}&eventAfter=${eventAfter}`,
    );
    expect(
      screen.getByRole("link", { name: "More timeline events" }),
    ).toHaveAttribute(
      "href",
      `/people/${personId}?view=names&nameAfter=${nameAfter}&eventAfter=${nextEventCursor}`,
    );
  });
});
