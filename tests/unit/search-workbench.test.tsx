import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  SearchWorkbench,
  type SearchWorkbenchAdapter,
  type SearchWorkbenchPage,
  type SearchWorkbenchSavedQuery,
} from "@/components/search/search-workbench";

const PRINCIPAL = "018f0000-0000-7000-8000-000000000001";
const OTHER_PRINCIPAL = "018f0000-0000-7000-8000-000000000002";
const RESULT_ONE = "018f0000-0000-7000-8000-000000000011";
const RESULT_TWO = "018f0000-0000-7000-8000-000000000012";
const SAVED_ID = "018f0000-0000-7000-8000-000000000021";

const emptyPage = (): SearchWorkbenchPage => ({
  nodes: [],
  pageInfo: { endCursor: null, hasNextPage: false },
});

const saved = (overrides: Partial<SearchWorkbenchSavedQuery> = {}) => ({
  archivedAt: null,
  createdAt: "2026-08-03T12:00:00.000Z",
  id: SAVED_ID,
  name: "People named Alice",
  ownerPrincipalId: PRINCIPAL,
  queryAst: {
    schema: "humans.search-query",
    version: 1,
    match: { type: "text", query: "Alice" },
    kinds: ["PERSON"],
    filters: {},
    pageSize: 25,
  },
  sharing: "PRIVATE" as const,
  updatedAt: "2026-08-03T12:00:00.000Z",
  version: 1,
  ...overrides,
});

function adapter(
  overrides: Partial<SearchWorkbenchAdapter> = {},
): SearchWorkbenchAdapter {
  return {
    archiveSaved: vi.fn().mockResolvedValue(saved({ archivedAt: "now" })),
    createSaved: vi.fn().mockResolvedValue(saved()),
    listSaved: vi.fn().mockResolvedValue({
      nodes: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    }),
    readSaved: vi.fn().mockResolvedValue(saved()),
    runSaved: vi.fn().mockResolvedValue(emptyPage()),
    search: vi.fn().mockResolvedValue(emptyPage()),
    updateSaved: vi.fn().mockResolvedValue(saved({ version: 2 })),
    ...overrides,
  };
}

function workbench(
  searchAdapter: SearchWorkbenchAdapter,
  props: Partial<Parameters<typeof SearchWorkbench>[0]> = {},
) {
  return (
    <SearchWorkbench
      adapter={searchAdapter}
      canManageSaved
      viewerPrincipalId={PRINCIPAL}
      workspaceIdentity="workspace-alpha"
      {...props}
    />
  );
}

describe("SearchWorkbench", () => {
  it("renders structured snippets as text and advances a deduplicated keyset", async () => {
    const user = userEvent.setup();
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [
          {
            id: RESULT_ONE,
            kind: "PERSON",
            rank: 0.8,
            snippet: [{ matched: true, text: "Alice" }],
            title: "Alice Example",
            updatedAt: "2026-08-03T12:00:00.000Z",
          },
          {
            id: RESULT_ONE,
            kind: "PERSON",
            rank: 0.8,
            snippet: [
              { matched: false, text: "<img src=x onerror=alert(1)> " },
              { matched: true, text: "Alice" },
            ],
            title: "Alice Example",
            updatedAt: "2026-08-03T12:00:00.000Z",
          },
        ],
        pageInfo: { endCursor: "search-page-one", hasNextPage: true },
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: RESULT_TWO,
            kind: "FACT",
            rank: 0.5,
            snippet: [{ matched: true, text: "Alice researcher" }],
            title: "Research role",
            updatedAt: "2026-08-03T12:01:00.000Z",
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      });
    render(workbench(adapter({ search })));

    await user.type(screen.getByLabelText("Search query"), "Alice");
    await user.click(screen.getByRole("button", { name: "Search" }));

    const results = await screen.findByRole("list", {
      name: "Authorized search results",
    });
    expect(
      within(results).getByText("Alice", { selector: "mark" }),
    ).toBeVisible();
    expect(
      within(results).getByText(/<img src=x onerror=alert\(1\)>/u),
    ).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Load more results" }));
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "search-page-one" }),
    );
    expect(await screen.findByText("Research role")).toBeVisible();
    expect(screen.getAllByText("Alice Example")).toHaveLength(1);
  });

  it("rejects a non-advancing search cursor without duplicating results", async () => {
    const user = userEvent.setup();
    const search = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: RESULT_ONE,
          kind: "PERSON",
          rank: 1,
          snippet: [{ matched: true, text: "Cycle" }],
          title: "Cycle result",
          updatedAt: "2026-08-03T12:00:00.000Z",
        },
      ],
      pageInfo: { endCursor: "same-cursor", hasNextPage: true },
    });
    render(workbench(adapter({ search })));
    await user.type(screen.getByLabelText("Search query"), "Cycle");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(
      await screen.findByRole("button", { name: "Load more results" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Search could not be completed",
    );
    expect(screen.getAllByText("Cycle result")).toHaveLength(1);
  });

  it("supports both protected exact branches without allowing persistence", async () => {
    const user = userEvent.setup();
    const search = vi.fn().mockResolvedValue(emptyPage());
    const createSaved = vi.fn();
    render(workbench(adapter({ createSaved, search })));

    await user.selectOptions(
      screen.getByLabelText("Search mode"),
      "PROTECTED_EXACT",
    );
    await user.type(screen.getByLabelText("Protected value"), "+12125550188");
    expect(
      screen.getByRole("button", { name: "Save current query" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenLastCalledWith({
      version: 1,
      match: {
        type: "PROTECTED_EXACT",
        protectedKind: "PHONE",
        value: "+12125550188",
      },
      kinds: ["PERSON"],
      filters: {},
      first: 25,
    });

    await user.selectOptions(
      screen.getByLabelText("Protected value kind"),
      "PERSON_IDENTIFIER",
    );
    expect(screen.getByLabelText("Protected value")).toHaveValue("");
    await user.type(screen.getByLabelText("Protected value"), "Employee 88");
    await user.type(
      screen.getByLabelText("Identifier namespace"),
      "employee.id",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenLastCalledWith({
      version: 1,
      match: {
        type: "PROTECTED_EXACT",
        protectedKind: "PERSON_IDENTIFIER",
        namespace: "employee.id",
        value: "Employee 88",
      },
      kinds: ["PERSON"],
      filters: {},
      first: 25,
    });
    expect(createSaved).not.toHaveBeenCalled();
  });

  it("serializes every allowlisted filter and bounded page size", async () => {
    const user = userEvent.setup();
    const search = vi.fn().mockResolvedValue(emptyPage());
    render(workbench(adapter({ search })));
    await user.type(screen.getByLabelText("Search query"), "filtered");
    await user.selectOptions(screen.getByLabelText("Results per page"), "100");
    await user.click(screen.getByText("Structured filters"));
    await user.type(screen.getByLabelText("Person IDs"), RESULT_ONE);
    await user.type(screen.getByLabelText("Fact definition IDs"), RESULT_TWO);
    await user.type(screen.getByLabelText("Relationship type IDs"), SAVED_ID);
    await user.type(screen.getByLabelText("Source IDs"), PRINCIPAL);
    await user.selectOptions(
      screen.getByLabelText("Fact state"),
      "corroborated",
    );
    await user.selectOptions(
      screen.getByLabelText("Relationship state"),
      "inferred",
    );
    await user.click(screen.getByLabelText("PUBLIC"));
    await user.type(screen.getByLabelText("From"), "2026-08-01T10:00");
    await user.type(screen.getByLabelText("Until"), "2026-08-02T10:00");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        first: 100,
        filters: {
          factDefinitionIds: [RESULT_TWO],
          factStates: ["corroborated"],
          from: new Date("2026-08-01T10:00").toISOString(),
          personIds: [RESULT_ONE],
          relationshipStates: ["inferred"],
          relationshipTypeIds: [SAVED_ID],
          sensitivities: ["PUBLIC"],
          sourceIds: [PRINCIPAL],
          until: new Date("2026-08-02T10:00").toISOString(),
        },
      }),
    );

    await user.clear(screen.getByLabelText("From"));
    await user.clear(screen.getByLabelText("Until"));
    await user.type(screen.getByLabelText("Active at"), "2026-08-03T10:00");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          at: new Date("2026-08-03T10:00").toISOString(),
        }),
      }),
    );
  });

  it.each([
    ["VALIDATION_FAILED", "Search input is invalid"],
    ["RATE_LIMITED", "Search capacity is temporarily exhausted"],
    ["PROVIDER_UNAVAILABLE", "Search is temporarily unavailable"],
    ["NOT_FOUND", "The requested search is no longer available"],
  ])(
    "shows a safe explicit %s state without persisting query text",
    async (code, message) => {
      const user = userEvent.setup();
      const history = vi.spyOn(window.history, "replaceState");
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const consoles = ["debug", "error", "info", "log", "warn"].map((method) =>
        vi.spyOn(console, method as "log").mockImplementation(() => undefined),
      );
      const search = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("private phrase"), { code }),
        );
      render(workbench(adapter({ search })));

      await user.type(screen.getByLabelText("Search query"), "private phrase");
      await user.click(screen.getByRole("button", { name: "Search" }));

      expect(await screen.findByRole("status")).toHaveTextContent(message);
      expect(history).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(
        window.localStorage?.getItem?.("private phrase") ?? null,
      ).toBeNull();
      expect(
        window.sessionStorage?.getItem?.("private phrase") ?? null,
      ).toBeNull();
      for (const method of consoles) expect(method).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).not.toHaveTextContent(
        "private phrase",
      );
      expect(window.location.search).toBe("");
      history.mockRestore();
      storage.mockRestore();
      for (const method of consoles) method.mockRestore();
    },
  );

  it("announces loading and explicit empty authorization results", async () => {
    const user = userEvent.setup();
    let resolve!: (value: SearchWorkbenchPage) => void;
    const pending = new Promise<SearchWorkbenchPage>((done) => {
      resolve = done;
    });
    render(workbench(adapter({ search: vi.fn().mockReturnValue(pending) })));
    await user.type(screen.getByLabelText("Search query"), "nothing");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Searching authorized records",
    );
    await act(async () => resolve(emptyPage()));
    expect(screen.getByRole("status")).toHaveTextContent(
      "No authorized results matched",
    );
  });

  it("supports owner-aware create/read/run/update/archive flows with sharing disclosure", async () => {
    const user = userEvent.setup();
    const owned = saved();
    const shared = saved({
      id: "018f0000-0000-7000-8000-000000000022",
      name: "Shared research",
      ownerPrincipalId: OTHER_PRINCIPAL,
      sharing: "WORKSPACE",
    });
    const searchAdapter = adapter({
      listSaved: vi.fn().mockResolvedValue({
        nodes: [owned, shared],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      readSaved: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === shared.id ? shared : owned),
        ),
      runSaved: vi.fn().mockResolvedValue({
        nodes: [
          {
            id: RESULT_ONE,
            kind: "PERSON",
            rank: 1,
            snippet: [{ matched: true, text: "Alice" }],
            title: "Alice Example",
            updatedAt: "2026-08-03T12:00:00.000Z",
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
    });
    render(workbench(searchAdapter));

    expect(await screen.findByText("Shared research")).toBeVisible();
    expect(screen.getByText(/Workspace queries are readable/u)).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Saved query"), owned.id);
    expect(searchAdapter.readSaved).toHaveBeenCalledWith(owned.id);
    await user.click(screen.getByRole("button", { name: "Run saved query" }));
    expect(searchAdapter.runSaved).toHaveBeenCalledWith(owned.id);
    expect(await screen.findByText("Alice Example")).toBeVisible();

    await user.clear(screen.getByLabelText("Saved query name"));
    await user.type(screen.getByLabelText("Saved query name"), "Updated query");
    await user.click(
      screen.getByRole("button", { name: "Update saved query" }),
    );
    expect(searchAdapter.updateSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        id: owned.id,
        name: "Updated query",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Archive saved query" }),
    );
    expect(searchAdapter.archiveSaved).toHaveBeenCalledWith(owned.id, 2);

    await user.type(screen.getByLabelText("Search query"), "New research");
    await user.clear(screen.getByLabelText("Saved query name"));
    await user.type(screen.getByLabelText("Saved query name"), "New query");
    await user.click(
      screen.getByRole("button", { name: "Save current query" }),
    );
    expect(searchAdapter.createSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New query", sharing: "PRIVATE" }),
    );

    await user.selectOptions(screen.getByLabelText("Saved query"), shared.id);
    expect(
      await screen.findByText(/read-only because you are not its owner/u),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Update saved query" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Archive saved query" }),
    ).toBeDisabled();
  });

  it("clears sensitive state and ignores stale results when the workspace changes", async () => {
    const user = userEvent.setup();
    let resolveSearch!: (value: SearchWorkbenchPage) => void;
    let resolveRead!: (value: SearchWorkbenchSavedQuery) => void;
    let resolveSecondList!: (value: {
      nodes: SearchWorkbenchSavedQuery[];
      pageInfo: { endCursor: null; hasNextPage: false };
    }) => void;
    const pending = new Promise<SearchWorkbenchPage>((resolve) => {
      resolveSearch = resolve;
    });
    const pendingRead = new Promise<SearchWorkbenchSavedQuery>((resolve) => {
      resolveRead = resolve;
    });
    const pendingList = new Promise<{
      nodes: SearchWorkbenchSavedQuery[];
      pageInfo: { endCursor: null; hasNextPage: false };
    }>((resolve) => {
      resolveSecondList = resolve;
    });
    const listed = saved();
    const searchAdapter = adapter({
      listSaved: vi
        .fn()
        .mockResolvedValueOnce({
          nodes: [listed],
          pageInfo: { endCursor: "saved-page-one", hasNextPage: true },
        })
        .mockReturnValueOnce(pendingList)
        .mockResolvedValueOnce({
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        }),
      readSaved: vi.fn().mockReturnValue(pendingRead),
      search: vi.fn().mockReturnValue(pending),
    });
    const { rerender } = render(workbench(searchAdapter));
    await screen.findByRole("option", { name: listed.name });
    await user.type(screen.getByLabelText("Search query"), "workspace secret");
    await user.type(
      screen.getByLabelText("Saved query name"),
      "stale saved name",
    );
    await user.click(
      screen.getByRole("button", { name: "Load more saved queries" }),
    );
    await user.selectOptions(screen.getByLabelText("Saved query"), listed.id);
    await user.click(screen.getByRole("button", { name: "Search" }));

    rerender(workbench(searchAdapter, { workspaceIdentity: "workspace-beta" }));
    expect(screen.getByLabelText("Search query")).toHaveValue("");
    expect(screen.getByLabelText("Saved query")).toHaveValue("");
    expect(screen.getByLabelText("Saved query name")).toHaveValue("");
    expect(
      screen.queryByRole("list", { name: "Authorized search results" }),
    ).toBeNull();
    await act(async () => {
      resolveRead(listed);
      resolveSearch({
        nodes: [
          {
            id: RESULT_ONE,
            kind: "PERSON",
            rank: 1,
            snippet: [{ matched: true, text: "workspace secret" }],
            title: "Stale result",
            updatedAt: "2026-08-03T12:00:00.000Z",
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      });
      resolveSecondList({
        nodes: [
          saved({
            id: "018f0000-0000-7000-8000-000000000099",
            name: "Stale list",
          }),
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      });
    });
    await waitFor(() => expect(screen.queryByText("Stale result")).toBeNull());
    expect(screen.queryByText("Stale list")).toBeNull();
    expect(screen.getByLabelText("Saved query name")).toHaveValue("");
  });
});
