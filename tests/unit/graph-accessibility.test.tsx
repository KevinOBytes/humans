import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GraphInspector } from "@/components/graph/graph-inspector";
import {
  GraphAnalysis,
  type GraphAnalysisAdapter,
  type GraphAnalysisPayload,
  type GraphAnalysisResultListPage,
} from "@/components/graph/graph-analysis";
import {
  graphPageResult,
  savedViewGraphFilter,
  savedViewPositions,
} from "@/components/graph/graph-page-model";
import { GraphExplorer } from "@/components/graph/graph-explorer";
import { GraphExportMenu } from "@/components/graph/graph-export-menu";
import {
  GraphSavedViews,
  type GraphSavedViewAdapter,
  type GraphSavedViewRun,
} from "@/components/graph/graph-saved-views";
import {
  canRetryGraphWebGL,
  chooseGraphVisualMode,
} from "@/components/graph/graph-renderer";
import {
  forceAtlasParameters,
  initialPreviewNodeIds,
  motionDetailNodeIds,
  shouldHideGraphEdge,
  shouldHideGraphNode,
  shouldRunAnimatedLayout,
} from "@/components/graph/graph-renderer-state";
import { RelationshipEditor } from "@/components/graph/relationship-editor";
import { GraphTable } from "@/components/graph/graph-table";
import type { GraphResult } from "@/modules/graph/types";
import { graphResultFixture, IDS } from "@/../tests/fixtures/graph";

let canvasContext: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  canvasContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => null);
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterAll(() => {
  canvasContext.mockRestore();
  vi.unstubAllGlobals();
});

function pagedGraph(): GraphResult {
  return {
    ...graphResultFixture,
    nodes: Array.from({ length: 51 }, (_, index) => ({
      ...graphResultFixture.nodes[0]!,
      id: `018f0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
      displayName: `Person ${String(index + 1).padStart(2, "0")}`,
    })),
  };
}

function pagedRelationshipsGraph(): GraphResult {
  return {
    ...graphResultFixture,
    edges: Array.from({ length: 51 }, (_, index) => ({
      ...graphResultFixture.edges[0]!,
      id: `018f0000-0000-7000-8003-${String(index + 1).padStart(12, "0")}`,
      relationshipId: `018f0000-0000-7000-8004-${String(index + 1).padStart(12, "0")}`,
      forwardLabel: `relationship ${String(index + 1).padStart(2, "0")}`,
    })),
  };
}

describe("GraphTable", () => {
  it("renders captioned native tables with direction and non-color state text", () => {
    render(
      <GraphTable
        result={graphResultFixture}
        selected={null}
        onSelect={vi.fn()}
      />,
    );

    const nodes = screen.getByRole("table", { name: "Loaded people" });
    expect(nodes).toBeVisible();
    for (const header of [
      "Name",
      "Status",
      "Sensitivity",
      "Degree",
      "Community",
      "Details",
    ]) {
      expect(
        within(nodes).getByRole("columnheader", { name: header }),
      ).toBeVisible();
    }

    const relationships = screen.getByRole("table", {
      name: "Loaded relationships",
    });
    for (const header of [
      "Source",
      "Relationship and direction",
      "Target",
      "State",
      "Confidence",
      "When",
      "Details",
    ]) {
      expect(
        within(relationships).getByRole("columnheader", { name: header }),
      ).toBeVisible();
    }
    expect(within(relationships).getByText("knows (directed)")).toBeVisible();
    expect(
      within(relationships).getByText("colleague (undirected)"),
    ).toBeVisible();
    expect(within(relationships).getByText("disputed")).toBeVisible();
  });

  it("pages every returned person in fixed groups of 50", async () => {
    const user = userEvent.setup();
    render(
      <GraphTable result={pagedGraph()} selected={null} onSelect={vi.fn()} />,
    );
    const nodesRegion = screen.getByRole("region", { name: "Loaded people" });
    expect(within(nodesRegion).getAllByRole("row")).toHaveLength(51);
    expect(
      within(nodesRegion).queryByText("Person 51"),
    ).not.toBeInTheDocument();

    await user.click(
      within(nodesRegion).getByRole("button", { name: "Next people page" }),
    );
    expect(within(nodesRegion).getByText("Person 51")).toBeVisible();
    expect(within(nodesRegion).getByText("Page 2 of 2")).toBeVisible();
  });

  it("pages every returned relationship in fixed groups of 50", async () => {
    const user = userEvent.setup();
    render(
      <GraphTable
        result={pagedRelationshipsGraph()}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    const relationshipsRegion = screen.getByRole("region", {
      name: "Loaded relationships",
    });
    expect(within(relationshipsRegion).getAllByRole("row")).toHaveLength(51);
    expect(
      within(relationshipsRegion).queryByText(/relationship 51/u),
    ).not.toBeInTheDocument();

    await user.click(
      within(relationshipsRegion).getByRole("button", {
        name: "Next relationships page",
      }),
    );
    expect(
      within(relationshipsRegion).getByText(/relationship 51/u),
    ).toBeVisible();
    expect(within(relationshipsRegion).getByText("Page 2 of 2")).toBeVisible();
  });

  it("identifies selection in text and passes the initiating control", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <GraphTable
        result={graphResultFixture}
        selected={{ kind: "node", id: IDS.alice }}
        onSelect={onSelect}
      />,
    );
    const selected = screen.getByRole("button", {
      name: "Details for =Researcher, Alice, selected",
    });
    expect(selected).toHaveAttribute("aria-current", "true");
    await user.click(
      screen.getByRole("button", { name: /Details for Bob <script>/u }),
    );
    expect(onSelect).toHaveBeenCalledWith(
      { kind: "node", id: IDS.bob },
      expect.any(HTMLElement),
    );
  });
});

describe("GraphInspector", () => {
  it("shows only returned fields and restores focus when closed", async () => {
    const user = userEvent.setup();
    const focusRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    render(
      <>
        <button ref={focusRef}>Origin</button>
        <GraphInspector
          closeFocusRef={focusRef}
          onClose={onClose}
          result={graphResultFixture}
          selection={{ kind: "node", id: IDS.alice }}
        />
      </>,
    );
    expect(
      screen.getByRole("heading", { name: "=Researcher, Alice" }),
    ).toBeVisible();
    expect(screen.getByText("internal")).toBeVisible();
    expect(screen.queryByText(/biography/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(focusRef.current).toHaveFocus();
  });
});

describe("GraphExplorer", () => {
  it("labels local filtering and announces visible loaded counts", async () => {
    const user = userEvent.setup();
    render(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        result={graphResultFixture}
      />,
    );
    const filter = screen.getByRole("textbox", {
      name: "Filter loaded people",
    });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    await user.type(filter, "Casey");

    expect(
      screen.getByRole("status", { name: "Graph explorer status" }),
    ).toHaveTextContent(
      "Showing 1 of 3 loaded people and 1 of 4 loaded relationships",
    );
    const people = screen.getByRole("table", { name: "Loaded people" });
    expect(within(people).getByText("Casey")).toBeVisible();
    expect(
      within(people).queryByText("=Researcher, Alice"),
    ).not.toBeInTheDocument();
  });

  it("keeps table selection synchronized with one inspector and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        result={graphResultFixture}
      />,
    );
    const alice = screen.getByRole("button", {
      name: "Details for =Researcher, Alice",
    });
    await user.click(alice);
    expect(
      screen.getByRole("heading", { name: "=Researcher, Alice" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(alice).toHaveFocus();
  });

  it("finds a local natural-direction path between exactly two visible people", async () => {
    const user = userEvent.setup();
    render(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        result={graphResultFixture}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start path mode" }));
    await user.click(
      screen.getByRole("button", { name: "Details for =Researcher, Alice" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Details for Bob <script>/u }),
    );
    expect(
      screen.getByRole("status", { name: "Graph explorer status" }),
    ).toHaveTextContent("Path contains 2 people and 1 relationship");
  });

  it("does not expose relationship editing without permission", () => {
    const { rerender } = render(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        result={graphResultFixture}
        canEditRelationships={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit selected neighborhood" }),
    ).not.toBeInTheDocument();
    rerender(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        result={graphResultFixture}
        canEditRelationships
      />,
    );
    expect(
      screen.getByRole("button", { name: "Edit selected neighborhood" }),
    ).toBeDisabled();
  });

  it("persists an authorized view before enabling Copy link", async () => {
    const user = userEvent.setup();
    const savedViewAdapter: GraphSavedViewAdapter = {
      list: vi.fn().mockResolvedValue({
        nodes: [],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      create: vi.fn().mockResolvedValue({
        id: IDS.alice,
        name: "Graph view",
        version: 1,
        sharing: "PRIVATE",
      }),
      update: vi.fn(),
      archive: vi.fn(),
      run: vi.fn(),
    };
    render(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        result={graphResultFixture}
        canSaveViews
        savedViewAdapter={savedViewAdapter}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Copy selected view link" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save new view" }));
    expect(
      await screen.findByRole("button", { name: "Copy selected view link" }),
    ).toBeEnabled();
    expect(savedViewAdapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ mode: "WORKSPACE" }),
        positions: expect.arrayContaining([
          expect.objectContaining({ id: IDS.alice }),
        ]),
      }),
    );
  });

  it("applies every typed relationship and temporal filter through generated graph data", async () => {
    const user = userEvent.setup();
    const filtered: GraphResult = {
      ...graphResultFixture,
      nodes: [graphResultFixture.nodes[2]!],
      edges: [],
      normalizedFilter: {
        ...graphResultFixture.normalizedFilter,
        relationshipTypeIds: [IDS.typeUndirected],
        relationshipStates: ["disputed"],
        sensitivities: ["confidential"],
        minimumConfidence: 0.7,
        from: "2024-01-01T00:00:00.000Z",
        until: "2025-01-01T00:00:00.000Z",
      },
      limits: {
        ...graphResultFixture.limits,
        returnedNodeCount: 1,
        returnedEdgeCount: 0,
      },
    };
    const queryAdapter = vi.fn().mockResolvedValue(filtered);
    const initialUrl = window.location.href;
    render(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        queryAdapter={queryAdapter}
        relationshipTypes={[
          { id: IDS.typeDirected, label: "knows" },
          { id: IDS.typeUndirected, label: "colleague" },
        ]}
        result={graphResultFixture}
      />,
    );

    await user.click(screen.getByText("Relationship and time filters"));
    await user.click(screen.getByRole("checkbox", { name: "colleague" }));
    await user.click(screen.getByRole("checkbox", { name: "disputed" }));
    await user.click(screen.getByRole("checkbox", { name: "confidential" }));
    await user.clear(
      screen.getByRole("spinbutton", { name: "Minimum confidence" }),
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Minimum confidence" }),
      "0.7",
    );
    await user.click(screen.getByRole("radio", { name: "Overlapping range" }));
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2024-01-01T00:00" },
    });
    fireEvent.change(screen.getByLabelText("Until"), {
      target: { value: "2025-01-01T00:00" },
    });
    await user.click(
      screen.getByRole("button", { name: "Apply generated graph filters" }),
    );

    expect(queryAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        relationshipTypeIds: [IDS.typeUndirected],
        relationshipStates: ["DISPUTED"],
        sensitivities: ["CONFIDENTIAL"],
        minimumConfidence: 0.7,
        at: undefined,
        from: expect.any(String),
        until: expect.any(String),
      }),
    );
    expect(await screen.findByText("1 people loaded")).toBeVisible();
    expect(window.location.href).toBe(initialUrl);
  });

  it("rejects invalid confidence and temporal fields before querying", async () => {
    const user = userEvent.setup();
    const queryAdapter = vi.fn();
    render(
      <GraphExplorer
        workspaceIdentity={IDS.alice}
        queryAdapter={queryAdapter}
        result={graphResultFixture}
      />,
    );
    await user.click(screen.getByText("Relationship and time filters"));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Minimum confidence" }),
      { target: { value: "1.5" } },
    );
    await user.click(
      screen.getByRole("button", { name: "Apply generated graph filters" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Minimum confidence must be a number from 0 through 1.",
    );
    expect(queryAdapter).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Minimum confidence" }),
      { target: { value: "" } },
    );
    await user.click(screen.getByRole("radio", { name: "At instant" }));
    await user.click(
      screen.getByRole("button", { name: "Apply generated graph filters" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a valid instant for the time filter.",
    );
    expect(queryAdapter).not.toHaveBeenCalled();
  });

  it("resets generated filters when the workspace or graph fingerprint changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GraphExplorer
        workspaceIdentity="workspace-alpha"
        relationshipTypes={[{ id: IDS.typeUndirected, label: "colleague" }]}
        result={graphResultFixture}
      />,
    );
    await user.click(screen.getByText("Relationship and time filters"));
    await user.click(screen.getByRole("checkbox", { name: "colleague" }));
    await user.click(screen.getByRole("checkbox", { name: "disputed" }));
    expect(screen.getByRole("checkbox", { name: "colleague" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "disputed" })).toBeChecked();

    rerender(
      <GraphExplorer
        workspaceIdentity="workspace-beta"
        relationshipTypes={[{ id: IDS.typeUndirected, label: "colleague" }]}
        result={{ ...graphResultFixture, fingerprint: "e".repeat(64) }}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: "colleague" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "disputed" }),
    ).not.toBeChecked();
  });
});

describe("chooseGraphVisualMode", () => {
  it("uses bounded Canvas 2D and then tables when WebGL is unavailable", () => {
    expect(
      chooseGraphVisualMode({
        webglAvailable: true,
        contextLosses: 0,
        nodeCount: 10_000,
        edgeCount: 25_000,
      }),
    ).toBe("sigma");
    expect(
      chooseGraphVisualMode({
        webglAvailable: false,
        contextLosses: 0,
        nodeCount: 2_000,
        edgeCount: 5_000,
      }),
    ).toBe("canvas");
    expect(
      chooseGraphVisualMode({
        webglAvailable: false,
        contextLosses: 0,
        nodeCount: 2_001,
        edgeCount: 5_000,
      }),
    ).toBe("table");
    expect(
      chooseGraphVisualMode({
        webglAvailable: true,
        contextLosses: 2,
        nodeCount: 3,
        edgeCount: 4,
      }),
    ).toBe("table");
    expect(canRetryGraphWebGL(1)).toBe(true);
    expect(canRetryGraphWebGL(2)).toBe(false);
  });
});

describe("forceAtlasParameters", () => {
  it("uses inferred bounded settings and Barnes-Hut only for large graphs", () => {
    const small = forceAtlasParameters(100);
    const large = forceAtlasParameters(2_000);
    expect(small.settings.barnesHutOptimize).toBe(false);
    expect(large.settings.barnesHutOptimize).toBe(true);
    expect(large.settings.slowDown).toBeGreaterThanOrEqual(1);
    expect(large.settings.slowDown).toBeLessThanOrEqual(10);
  });

  it("does not start animated layout when reduced motion is requested", () => {
    expect(shouldRunAnimatedLayout(() => ({ matches: true }))).toBe(false);
    expect(shouldRunAnimatedLayout(() => ({ matches: false }))).toBe(true);
    expect(shouldRunAnimatedLayout(undefined)).toBe(true);
  });

  it("selects deterministic motion detail while retaining selected and path people", () => {
    const ids = Array.from({ length: 300 }, (_, index) =>
      String(300 - index).padStart(3, "0"),
    );
    const detail = motionDetailNodeIds({
      nodeIds: ids,
      pathNodeIds: new Set(["251"]),
      selectedNodeId: "275",
    });

    expect(detail.size).toBe(102);
    expect([...detail].slice(0, 3)).toEqual(["001", "004", "007"]);
    expect(detail).toContain("100");
    expect(detail).toContain("251");
    expect(detail).toContain("275");
  });

  it("selects a bounded deterministic relationship-preserving preview for the first large render", () => {
    const nodeIds = Array.from({ length: 300 }, (_, index) =>
      String(index + 1).padStart(3, "0"),
    );
    const edges = Array.from({ length: 250 }, (_, index) => ({
      id: `edge-${String(250 - index).padStart(3, "0")}`,
      source: String(index + 1).padStart(3, "0"),
      target: String(index + 2).padStart(3, "0"),
    }));

    const preview = initialPreviewNodeIds({ nodeIds, edges });
    const shuffled = initialPreviewNodeIds({
      nodeIds: [...nodeIds].reverse(),
      edges: [...edges].reverse(),
    });

    expect(preview.size).toBe(100);
    expect([...preview].sort()).toEqual([...shuffled].sort());
    for (const edge of [...edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 50)) {
      expect(preview).toContain(edge.source);
      expect(preview).toContain(edge.target);
    }
  });

  it("restores every filtered-in graph item after motion without exposing filtered items", () => {
    expect(
      shouldHideGraphNode({
        inMotionDetail: false,
        largeMotionGraph: true,
        motionDetailActive: true,
        visible: true,
      }),
    ).toBe(true);
    expect(
      shouldHideGraphNode({
        inMotionDetail: true,
        largeMotionGraph: true,
        motionDetailActive: true,
        visible: false,
      }),
    ).toBe(true);
    expect(
      shouldHideGraphNode({
        inMotionDetail: false,
        largeMotionGraph: true,
        motionDetailActive: false,
        visible: true,
      }),
    ).toBe(false);
    expect(
      shouldHideGraphNode({
        inMotionDetail: true,
        largeMotionGraph: true,
        motionDetailActive: false,
        visible: false,
      }),
    ).toBe(true);
    expect(
      shouldHideGraphEdge({
        largeMotionGraph: true,
        motionDetailActive: true,
        visible: true,
      }),
    ).toBe(true);
    expect(
      shouldHideGraphEdge({
        largeMotionGraph: true,
        motionDetailActive: false,
        visible: true,
      }),
    ).toBe(false);
  });
});

describe("GraphExportMenu", () => {
  it("discloses every deterministic authorized-result format", async () => {
    const user = userEvent.setup();
    render(<GraphExportMenu result={graphResultFixture} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    for (const label of [
      "Download JSON",
      "Download nodes CSV",
      "Download relationships CSV",
      "Download GEXF",
      "Download GraphML",
      "Download SVG",
      "Download PNG",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
  });
});

describe("RelationshipEditor", () => {
  it("labels the bounded one-hop editor and explains that drop never writes", () => {
    render(
      <RelationshipEditor
        focusId={IDS.alice}
        result={graphResultFixture}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Edit neighborhood" }),
    ).toBeVisible();
    expect(
      screen.getByText(/dropping a connection opens a form and never writes/i),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close relationship editor" }),
    ).toBeVisible();
  });

  it("requires explicit review before create, update, and archive mutations", async () => {
    const user = userEvent.setup();
    const mutationAdapter = {
      archive: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(true),
      update: vi.fn().mockResolvedValue(true),
    };
    render(
      <RelationshipEditor
        focusId={IDS.alice}
        mutationAdapter={mutationAdapter}
        relationshipTypes={[
          { id: IDS.typeDirected, label: "knows" },
          { id: IDS.typeUndirected, label: "colleague" },
        ]}
        result={graphResultFixture}
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Relationship source" }),
      IDS.alice,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Relationship target" }),
      IDS.bob,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Relationship type" }),
      IDS.typeDirected,
    );
    await user.click(
      screen.getByRole("button", { name: "Create relationship" }),
    );
    expect(mutationAdapter.create).toHaveBeenCalledWith({
      relationshipTypeId: IDS.typeDirected,
      sensitivity: "INTERNAL",
      sourcePersonId: IDS.alice,
      targetPersonId: IDS.bob,
    });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Existing relationship" }),
      IDS.directed,
    );
    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Existing relationship sensitivity",
      }),
      "CONFIDENTIAL",
    );
    await user.click(screen.getByRole("button", { name: "Review update" }));
    expect(mutationAdapter.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm update" }));
    expect(mutationAdapter.update).toHaveBeenCalledWith({
      expectedVersion: 2,
      relationshipId: IDS.directed,
      sensitivity: "CONFIDENTIAL",
    });

    await user.click(screen.getByRole("button", { name: "Review archive" }));
    expect(mutationAdapter.archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));
    expect(mutationAdapter.archive).toHaveBeenCalledWith({
      expectedVersion: 2,
      relationshipId: IDS.directed,
    });
  });

  it("limits every form person and relationship id to the capped editor graph", () => {
    const nodes = Array.from({ length: 102 }, (_, index) => ({
      ...graphResultFixture.nodes[0]!,
      id: `018f0000-0000-7000-8001-${String(index + 1).padStart(12, "0")}`,
      displayName: `Neighbor ${index + 1}`,
    }));
    const focus = nodes[0]!.id;
    const edges = nodes.slice(1).map((node, index) => ({
      ...graphResultFixture.edges[0]!,
      id: `018f0000-0000-7000-8002-${String(index + 1).padStart(12, "0")}`,
      relationshipId: `018f0000-0000-7000-8002-${String(index + 1).padStart(12, "0")}`,
      source: focus,
      target: node.id,
    }));
    const result: GraphResult = {
      ...graphResultFixture,
      nodes,
      edges,
      limits: {
        ...graphResultFixture.limits,
        returnedNodeCount: nodes.length,
        returnedEdgeCount: edges.length,
      },
    };

    render(
      <RelationshipEditor focusId={focus} result={result} onClose={vi.fn()} />,
    );

    const editorNodeIds = new Set(nodes.slice(0, 100).map((node) => node.id));
    const personValues = ["Relationship source", "Relationship target"].flatMap(
      (name) =>
        within(screen.getByRole("combobox", { name }))
          .getAllByRole("option")
          .map((option) => option.getAttribute("value"))
          .filter((value): value is string => Boolean(value)),
    );
    expect(personValues.every((id) => editorNodeIds.has(id))).toBe(true);
    expect(personValues).not.toContain(nodes.at(-1)!.id);

    const relationshipValues = within(
      screen.getByRole("combobox", { name: "Existing relationship" }),
    )
      .getAllByRole("option")
      .map((option) => option.getAttribute("value"))
      .filter((value): value is string => Boolean(value));
    expect(relationshipValues).toHaveLength(99);
    expect(relationshipValues).not.toContain(edges.at(-1)!.id);
  });
});

describe("GraphSavedViews", () => {
  it("keeps the most recently selected saved view when an earlier run resolves last", async () => {
    const user = userEvent.setup();
    const firstView = {
      id: IDS.alice,
      name: "First view",
      sharing: "PRIVATE" as const,
      version: 1,
    };
    const secondView = {
      ...firstView,
      id: IDS.bob,
      name: "Second view",
    };
    let resolveFirstRun!: (value: GraphSavedViewRun) => void;
    let resolveSecondRun!: (value: GraphSavedViewRun) => void;
    const firstRun = new Promise<GraphSavedViewRun>((resolve) => {
      resolveFirstRun = resolve;
    });
    const secondRun = new Promise<GraphSavedViewRun>((resolve) => {
      resolveSecondRun = resolve;
    });
    const adapter: GraphSavedViewAdapter = {
      list: vi.fn().mockResolvedValue({
        nodes: [firstView, secondView],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      run: vi
        .fn()
        .mockImplementation((id: string) =>
          id === firstView.id ? firstRun : secondRun,
        ),
    };
    const onRun = vi.fn();
    render(
      <GraphSavedViews
        workspaceIdentity={IDS.alice}
        adapter={adapter}
        canArchive={false}
        canCreate={false}
        canUpdate={false}
        capture={() => ({ filter: { mode: "WORKSPACE" } })}
        initialViewId={firstView.id}
        onRun={onRun}
        onStatus={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: "First view (private)" });
    await user.click(screen.getByRole("button", { name: "Run selected view" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved view" }),
      secondView.id,
    );
    const runSelectedView = screen.getByRole("button", {
      name: "Run selected view",
    });
    expect(runSelectedView).toBeEnabled();
    await user.click(runSelectedView);
    expect(adapter.run).toHaveBeenLastCalledWith(secondView.id);

    resolveSecondRun({ view: secondView, result: graphResultFixture });
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    resolveFirstRun({ view: firstView, result: graphResultFixture });
    await Promise.resolve();

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: secondView }),
    );
  });

  it("lists, names, shares, runs, versions, and explicitly archives saved views", async () => {
    const user = userEvent.setup();
    const listed = {
      id: IDS.alice,
      name: "Known network",
      sharing: "PRIVATE" as const,
      updatedAt: "2026-07-31T12:00:00.000Z",
      version: 3,
    };
    const created = {
      ...listed,
      id: IDS.bob,
      name: "Workspace network",
      version: 1,
    };
    const adapter: GraphSavedViewAdapter = {
      list: vi.fn().mockResolvedValue({
        nodes: [listed],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      create: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockResolvedValue({
        ...listed,
        name: "Updated network",
        sharing: "WORKSPACE",
        version: 4,
      }),
      archive: vi.fn().mockResolvedValue(true),
      run: vi
        .fn()
        .mockResolvedValue({ view: listed, result: graphResultFixture }),
    };
    const onRun = vi.fn();
    render(
      <GraphSavedViews
        workspaceIdentity={IDS.alice}
        adapter={adapter}
        canArchive
        canCreate
        canUpdate
        capture={() => ({ filter: { mode: "WORKSPACE" } })}
        initialViewId={listed.id}
        onRun={onRun}
        onStatus={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: "Known network (private)" });
    await user.click(screen.getByRole("button", { name: "Run selected view" }));
    expect(adapter.run).toHaveBeenCalledWith(listed.id);
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ result: graphResultFixture }),
    );

    await user.clear(screen.getByRole("textbox", { name: "View name" }));
    await user.type(
      screen.getByRole("textbox", { name: "View name" }),
      "Updated network",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sharing" }),
      "WORKSPACE",
    );
    await user.click(
      screen.getByRole("button", { name: "Update selected view" }),
    );
    expect(adapter.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: listed.id,
        expectedVersion: 3,
        name: "Updated network",
        sharing: "WORKSPACE",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Save new view" }));
    expect(adapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Updated network",
        sharing: "WORKSPACE",
      }),
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved view" }),
      listed.id,
    );
    await user.click(
      screen.getByRole("button", { name: "Archive selected view" }),
    );
    expect(adapter.archive).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Confirm archive view" }),
    );
    expect(adapter.archive).toHaveBeenCalledWith({
      id: listed.id,
      expectedVersion: 4,
    });
  });

  it("loads saved views and positions one explicit cursor page at a time", async () => {
    const user = userEvent.setup();
    const firstView = {
      id: IDS.alice,
      name: "First view",
      sharing: "PRIVATE" as const,
      version: 1,
    };
    const secondView = {
      ...firstView,
      id: IDS.bob,
      name: "Second view",
    };
    const list = vi.fn().mockImplementation(async (after?: string) =>
      after
        ? {
            nodes: [secondView],
            pageInfo: { endCursor: null, hasNextPage: false },
          }
        : {
            nodes: [firstView],
            pageInfo: { endCursor: "view-page-1", hasNextPage: true },
          },
    );
    const loadPositions = vi.fn().mockResolvedValue({
      positions: [{ id: IDS.bob, x: 3, y: 4 }],
      pageInfo: { endCursor: null, hasNextPage: false },
    });
    const adapter: GraphSavedViewAdapter = {
      list,
      loadPositions,
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      run: vi.fn().mockResolvedValue({
        view: firstView,
        result: graphResultFixture,
        positions: [{ id: IDS.alice, x: 1, y: 2 }],
        positionPageInfo: {
          endCursor: "position-page-1",
          hasNextPage: true,
        },
      }),
    };
    const onRun = vi.fn();
    render(
      <GraphSavedViews
        workspaceIdentity={IDS.alice}
        adapter={adapter}
        canArchive={false}
        canCreate={false}
        canUpdate={false}
        capture={() => ({ filter: { mode: "WORKSPACE" } })}
        initialViewId={firstView.id}
        onRun={onRun}
        onStatus={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: "First view (private)" });
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "Load more saved views" }),
    );
    expect(list).toHaveBeenLastCalledWith("view-page-1");
    expect(
      await screen.findByRole("option", { name: "Second view (private)" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Run selected view" }));
    await user.click(
      screen.getByRole("button", { name: "Load more saved positions" }),
    );
    expect(loadPositions).toHaveBeenCalledWith(firstView.id, "position-page-1");
    expect(onRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        positions: [
          { id: IDS.alice, x: 1, y: 2 },
          { id: IDS.bob, x: 3, y: 4 },
        ],
        positionPageInfo: { endCursor: null, hasNextPage: false },
      }),
    );
  });

  it("fails closed on duplicate saved-view ids and repeated cursors across pages", async () => {
    const user = userEvent.setup();
    const firstView = {
      id: IDS.alice,
      name: "First view",
      sharing: "PRIVATE" as const,
      version: 1,
    };
    const onStatus = vi.fn();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [firstView],
        pageInfo: { endCursor: "view-page-1", hasNextPage: true },
      })
      .mockResolvedValueOnce({
        nodes: [{ ...firstView, name: "Overwritten view" }],
        pageInfo: { endCursor: null, hasNextPage: false },
      });
    const adapter: GraphSavedViewAdapter = {
      list,
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      run: vi.fn(),
    };
    const { unmount } = render(
      <GraphSavedViews
        workspaceIdentity="workspace-alpha"
        adapter={adapter}
        canArchive={false}
        canCreate={false}
        canUpdate={false}
        capture={() => ({ filter: { mode: "WORKSPACE" } })}
        onRun={vi.fn()}
        onStatus={onStatus}
      />,
    );
    await screen.findByRole("option", { name: "First view (private)" });
    await user.click(
      screen.getByRole("button", { name: "Load more saved views" }),
    );
    expect(
      screen.queryByRole("option", { name: "Overwritten view (private)" }),
    ).not.toBeInTheDocument();
    expect(onStatus).toHaveBeenLastCalledWith(
      "More saved graph views could not be loaded.",
    );
    unmount();

    const repeatedCursorStatus = vi.fn();
    const repeatedCursorAdapter: GraphSavedViewAdapter = {
      ...adapter,
      list: vi
        .fn()
        .mockResolvedValueOnce({
          nodes: [firstView],
          pageInfo: { endCursor: "view-page-1", hasNextPage: true },
        })
        .mockResolvedValueOnce({
          nodes: [{ ...firstView, id: IDS.bob, name: "Second view" }],
          pageInfo: { endCursor: "view-page-1", hasNextPage: true },
        }),
    };
    render(
      <GraphSavedViews
        workspaceIdentity="workspace-alpha"
        adapter={repeatedCursorAdapter}
        canArchive={false}
        canCreate={false}
        canUpdate={false}
        capture={() => ({ filter: { mode: "WORKSPACE" } })}
        onRun={vi.fn()}
        onStatus={repeatedCursorStatus}
      />,
    );
    await screen.findByRole("option", { name: "First view (private)" });
    await user.click(
      screen.getByRole("button", { name: "Load more saved views" }),
    );
    expect(repeatedCursorStatus).toHaveBeenLastCalledWith(
      "More saved graph views could not be loaded.",
    );
  });

  it("invalidates listed and in-flight saved-view state on a workspace switch", async () => {
    const user = userEvent.setup();
    const oldView = {
      id: IDS.alice,
      name: "Old workspace view",
      sharing: "PRIVATE" as const,
      version: 1,
    };
    const newView = {
      ...oldView,
      id: IDS.bob,
      name: "New workspace view",
    };
    let resolveRun!: (value: GraphSavedViewRun) => void;
    const runPromise = new Promise<GraphSavedViewRun>((resolve) => {
      resolveRun = resolve;
    });
    const adapter: GraphSavedViewAdapter = {
      list: vi
        .fn()
        .mockResolvedValueOnce({
          nodes: [oldView],
          pageInfo: { endCursor: null, hasNextPage: false },
        })
        .mockResolvedValueOnce({
          nodes: [newView],
          pageInfo: { endCursor: null, hasNextPage: false },
        }),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      run: vi.fn().mockReturnValue(runPromise),
    };
    const onRun = vi.fn();
    const props = {
      adapter,
      canArchive: false,
      canCreate: false,
      canUpdate: false,
      capture: () => ({ filter: { mode: "WORKSPACE" as const } }),
      onRun,
      onStatus: vi.fn(),
    };
    const { rerender } = render(
      <GraphSavedViews {...props} workspaceIdentity="workspace-alpha" />,
    );
    await screen.findByRole("option", { name: "Old workspace view (private)" });
    await user.click(screen.getByRole("button", { name: "Run selected view" }));
    rerender(<GraphSavedViews {...props} workspaceIdentity="workspace-beta" />);
    await screen.findByRole("option", { name: "New workspace view (private)" });
    expect(
      screen.queryByRole("option", { name: "Old workspace view (private)" }),
    ).not.toBeInTheDocument();

    resolveRun({ view: oldView, result: graphResultFixture });
    await Promise.resolve();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("removes stale saved views immediately when its adapter changes", async () => {
    const listed = {
      id: IDS.alice,
      name: "Old workspace view",
      sharing: "PRIVATE" as const,
      version: 1,
    };
    const first: GraphSavedViewAdapter = {
      list: vi.fn().mockResolvedValue({
        nodes: [listed],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      run: vi.fn(),
    };
    const second: GraphSavedViewAdapter = {
      ...first,
      list: vi.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const onStatus = vi.fn();
    const { rerender } = render(
      <GraphSavedViews
        workspaceIdentity={IDS.alice}
        adapter={first}
        canArchive={false}
        canCreate={false}
        canUpdate={false}
        capture={() => ({ filter: { mode: "WORKSPACE" } })}
        onRun={vi.fn()}
        onStatus={onStatus}
      />,
    );
    await screen.findByRole("option", { name: "Old workspace view (private)" });
    rerender(
      <GraphSavedViews
        workspaceIdentity={IDS.bob}
        adapter={second}
        canArchive={false}
        canCreate={false}
        canUpdate={false}
        capture={() => ({ filter: { mode: "WORKSPACE" } })}
        onRun={vi.fn()}
        onStatus={onStatus}
      />,
    );
    expect(
      screen.queryByRole("option", { name: "Old workspace view (private)" }),
    ).not.toBeInTheDocument();
  });
});

describe("GraphAnalysis", () => {
  it("keeps results for the most recently selected run when an earlier result resolves last", async () => {
    const user = userEvent.setup();
    const firstRun = {
      id: IDS.directed,
      algorithm: "DEGREE",
      graphSnapshotId: IDS.parallel,
      state: "completed",
      startedAt: null,
      completedAt: null,
      createdAt: "2026-07-31T12:00:00.000Z",
    };
    const secondRun = { ...firstRun, id: IDS.undirected };
    let resolveFirstResults!: (value: GraphAnalysisResultListPage) => void;
    let resolveSecondResults!: typeof resolveFirstResults;
    const firstResults = new Promise<GraphAnalysisResultListPage>((resolve) => {
      resolveFirstResults = resolve;
    });
    const secondResults = new Promise<GraphAnalysisResultListPage>(
      (resolve) => {
        resolveSecondResults = resolve;
      },
    );
    const adapter: GraphAnalysisAdapter = {
      listRuns: vi.fn().mockResolvedValue({
        nodes: [firstRun, secondRun],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      results: vi
        .fn()
        .mockImplementation((id: string) =>
          id === firstRun.id ? firstResults : secondResults,
        ),
      run: vi.fn(),
      rerun: vi.fn(),
    };
    render(
      <GraphAnalysis
        workspaceIdentity={IDS.alice}
        adapter={adapter}
        canRun
        currentFilter={{ mode: "WORKSPACE" }}
        onGraph={vi.fn()}
        onStatus={vi.fn()}
        result={graphResultFixture}
      />,
    );

    await screen.findByRole("combobox", { name: "Previous run" });
    const select = screen.getByRole("combobox", { name: "Previous run" });
    await user.selectOptions(select, firstRun.id);
    await user.selectOptions(select, secondRun.id);

    await act(async () => {
      resolveSecondResults({
        nodes: [
          {
            id: IDS.self,
            resultKind: "degree",
            subjectPersonId: IDS.bob,
            value: 2,
            rank: 1,
            explanation: "Second run result.",
            createdAt: "2026-07-31T12:00:01.000Z",
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      });
    });
    expect(await screen.findByText("Second run result.")).toBeVisible();
    await act(async () => {
      resolveFirstResults({
        nodes: [
          {
            id: IDS.parallel,
            resultKind: "degree",
            subjectPersonId: IDS.alice,
            value: 3,
            rank: 1,
            explanation: "First run result.",
            createdAt: "2026-07-31T12:00:01.000Z",
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      });
    });

    expect(screen.getByText("Second run result.")).toBeVisible();
    expect(screen.queryByText("First run result.")).not.toBeInTheDocument();
  });

  it("discloses algorithms, runs and reruns snapshots, and renders metrics and stored results", async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:graph-analysis");
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const clickDownload = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const priorRun = {
      id: IDS.directed,
      algorithm: "DEGREE",
      graphSnapshotId: IDS.parallel,
      state: "completed",
      startedAt: "2026-07-31T12:00:00.000Z",
      completedAt: "2026-07-31T12:00:01.000Z",
      createdAt: "2026-07-31T12:00:00.000Z",
    };
    const nextRun = {
      ...priorRun,
      id: IDS.undirected,
      graphSnapshotId: IDS.self,
    };
    const adapter: GraphAnalysisAdapter = {
      createSnapshot: vi.fn().mockResolvedValue({
        algorithm: "PAGERANK",
        generatedAt: "2026-07-31T12:00:02.000Z",
        id: IDS.bob,
        manifestHash: "snapshot-manifest-hash",
      }),
      exportResults: vi.fn().mockResolvedValue({
        content: "[]",
        contentType: "application/json; charset=utf-8",
        filename: "graph-analysis.json",
        resultCount: 1,
        truncated: false,
      }),
      listRuns: vi.fn().mockResolvedValue({
        nodes: [priorRun],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      results: vi.fn().mockImplementation((_runId: string, after?: string) =>
        Promise.resolve(
          after
            ? {
                nodes: [
                  {
                    id: IDS.self,
                    resultKind: "degree",
                    subjectPersonId: IDS.bob,
                    value: 2,
                    rank: 2,
                    explanation: "Second result page.",
                    createdAt: "2026-07-31T12:00:02.000Z",
                  },
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              }
            : {
                nodes: [
                  {
                    id: IDS.parallel,
                    resultKind: "degree",
                    subjectPersonId: IDS.alice,
                    value: 3,
                    rank: 1,
                    explanation: "Visible incidence count.",
                    createdAt: "2026-07-31T12:00:01.000Z",
                  },
                ],
                pageInfo: { endCursor: "result-page-1", hasNextPage: true },
              },
        ),
      ),
      run: vi.fn().mockResolvedValue({
        run: nextRun,
        graph: graphResultFixture,
        metrics: [
          {
            personId: IDS.alice,
            metricKey: "pagerank",
            value: 0.75,
            rank: 1,
            algorithmVersion: "graphology-metrics@2.4.0/pagerank/humans-v1",
            explanation: "Structural score in this authorized snapshot.",
          },
        ],
      }),
      rerun: vi.fn().mockResolvedValue({
        run: nextRun,
        graph: graphResultFixture,
        metrics: [],
      }),
      replay: vi.fn().mockResolvedValue({
        snapshot: {
          algorithm: "PAGERANK",
          generatedAt: "2026-07-31T12:00:02.000Z",
          id: IDS.self,
          manifestHash: "snapshot-manifest-hash",
        },
        valid: true,
      }),
    };
    const onStatus = vi.fn();
    render(
      <GraphAnalysis
        workspaceIdentity={IDS.alice}
        adapter={adapter}
        canRun
        currentFilter={{ mode: "WORKSPACE" }}
        onGraph={vi.fn()}
        onStatus={onStatus}
        result={graphResultFixture}
      />,
    );

    await screen.findByRole("option", { name: /DEGREE — completed/u });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Previous run" }),
      priorRun.id,
    );
    expect(
      await screen.findByRole("table", {
        name: "Stored graph analysis results",
      }),
    ).toBeVisible();
    expect(screen.getByText("Visible incidence count.")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Load more analysis results" }),
    );
    expect(adapter.results).toHaveBeenLastCalledWith(
      priorRun.id,
      "result-page-1",
    );
    expect(await screen.findByText("Second result page.")).toBeVisible();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Algorithm" }),
      "PAGERANK",
    );
    expect(
      screen.getByText(/not a measure of human importance or truth/iu),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run analysis" }));
    expect(adapter.run).toHaveBeenCalledWith({
      algorithm: "PAGERANK",
      filter: { mode: "WORKSPACE" },
    });
    expect(
      await screen.findByRole("table", { name: "New graph analysis metrics" }),
    ).toBeVisible();
    expect(screen.getByText(/graphology-metrics@2\.4\.0/u)).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: "Create new analysis from snapshot",
      }),
    );
    expect(adapter.rerun).toHaveBeenCalledWith({
      algorithm: "PAGERANK",
      snapshotId: nextRun.graphSnapshotId,
    });

    await user.click(screen.getByRole("button", { name: "Create snapshot" }));
    expect(adapter.createSnapshot).toHaveBeenCalledWith({
      algorithm: "PAGERANK",
      filter: { mode: "WORKSPACE" },
    });
    expect(onStatus).toHaveBeenLastCalledWith(
      "Reproducibility snapshot created for PageRank.",
    );
    const createdSnapshotRegion = screen.getByRole("region", {
      name: "Latest created graph snapshot",
    });
    expect(within(createdSnapshotRegion).getByText(IDS.bob)).toBeVisible();
    expect(
      within(createdSnapshotRegion).getByText("2026-07-31T12:00:02.000Z"),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Check snapshot validity" }),
    );
    expect(adapter.replay).toHaveBeenCalledWith(IDS.bob);
    expect(onStatus).toHaveBeenLastCalledWith(
      "The selected snapshot is reproducible with current authorized data.",
    );

    await user.click(
      screen.getByRole("button", { name: "Export results JSON" }),
    );
    expect(adapter.exportResults).toHaveBeenCalledWith(nextRun.id, "JSON");
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(clickDownload).toHaveBeenCalledOnce();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Previous run" }),
      priorRun.id,
    );
    expect(
      screen.queryByRole("region", {
        name: "Latest created graph snapshot",
      }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Check snapshot validity" }),
    );
    expect(adapter.replay).toHaveBeenLastCalledWith(priorRun.graphSnapshotId);
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
    clickDownload.mockRestore();
  });

  it("invalidates listed and in-flight analysis state on a workspace switch", async () => {
    const user = userEvent.setup();
    const oldRun = {
      id: IDS.directed,
      algorithm: "DEGREE",
      graphSnapshotId: IDS.parallel,
      state: "completed",
      startedAt: null,
      completedAt: null,
      createdAt: "2026-07-31T12:00:00.000Z",
    };
    const newRun = { ...oldRun, id: IDS.undirected };
    let resolveAnalysis!: (value: GraphAnalysisPayload) => void;
    const analysisPromise = new Promise<GraphAnalysisPayload>((resolve) => {
      resolveAnalysis = resolve;
    });
    const adapter: GraphAnalysisAdapter = {
      createSnapshot: vi.fn().mockResolvedValue({
        algorithm: "DEGREE",
        generatedAt: "2026-07-31T12:00:02.000Z",
        id: IDS.bob,
        manifestHash: "snapshot-manifest-hash",
      }),
      listRuns: vi
        .fn()
        .mockResolvedValueOnce({
          nodes: [oldRun],
          pageInfo: { endCursor: null, hasNextPage: false },
        })
        .mockResolvedValueOnce({
          nodes: [newRun],
          pageInfo: { endCursor: null, hasNextPage: false },
        }),
      results: vi.fn().mockResolvedValue({
        nodes: [],
        pageInfo: { endCursor: null, hasNextPage: false },
      }),
      run: vi.fn().mockReturnValue(analysisPromise),
      rerun: vi.fn(),
    };
    const onGraph = vi.fn();
    const props = {
      adapter,
      canRun: true,
      currentFilter: { mode: "WORKSPACE" as const },
      onGraph,
      onStatus: vi.fn(),
      result: graphResultFixture,
    };
    const { rerender } = render(
      <GraphAnalysis {...props} workspaceIdentity="workspace-alpha" />,
    );
    await screen.findByRole("option", { name: /DEGREE — completed/u });
    await user.click(screen.getByRole("button", { name: "Create snapshot" }));
    expect(
      within(
        screen.getByRole("region", {
          name: "Latest created graph snapshot",
        }),
      ).getByText(IDS.bob),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run analysis" }));
    rerender(<GraphAnalysis {...props} workspaceIdentity="workspace-beta" />);
    await screen.findByRole("option", { name: /DEGREE — completed/u });
    expect(
      screen.queryByRole("region", {
        name: "Latest created graph snapshot",
      }),
    ).toBeNull();

    resolveAnalysis({
      run: oldRun,
      graph: graphResultFixture,
      metrics: [],
    });
    await Promise.resolve();
    expect(onGraph).not.toHaveBeenCalled();
  });
});

describe("graphPageResult", () => {
  it("maps the generated GraphQL transport without changing UUIDs", () => {
    const mapped = graphPageResult({
      ...graphResultFixture,
      nodes: graphResultFixture.nodes.map((node) => ({
        ...node,
        sensitivity: node.sensitivity.toUpperCase() as
          "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
      })),
      edges: graphResultFixture.edges.map((edge) => ({
        ...edge,
        state: edge.state.toUpperCase() as
          | "ASSERTED"
          | "CORROBORATED"
          | "DISPROVEN"
          | "DISPUTED"
          | "INACTIVE"
          | "INFERRED",
        sensitivity: edge.sensitivity.toUpperCase() as
          "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
      })),
      normalizedFilter: {
        ...graphResultFixture.normalizedFilter,
        relationshipStates:
          graphResultFixture.normalizedFilter.relationshipStates.map(
            (state) =>
              state.toUpperCase() as
                | "ASSERTED"
                | "CORROBORATED"
                | "DISPROVEN"
                | "DISPUTED"
                | "INACTIVE"
                | "INFERRED",
          ),
        sensitivities: [],
      },
    });
    expect(mapped.nodes[0]?.id).toBe(IDS.alice);
    expect(mapped.nodes[0]?.sensitivity).toBe("internal");
    expect(mapped.edges[0]?.id).toBe(IDS.directed);
  });

  it("maps a reauthorized saved view into a fresh graph query and positions", () => {
    const view = {
      id: IDS.alice,
      name: "Known network",
      version: 3,
      sharing: "PRIVATE" as const,
      filter: {
        mode: "NEIGHBORHOOD" as const,
        rootPersonIds: [IDS.alice],
        depth: 2,
        relationshipTypeIds: [IDS.typeDirected],
        relationshipStates: ["ASSERTED" as const],
        sensitivities: ["INTERNAL" as const],
        minimumConfidence: 0.5,
        at: null,
        from: null,
        until: null,
        nodeLimit: 100,
        edgeLimit: 250,
        includeIsolates: false,
      },
      layout: null,
      appearance: null,
      positions: {
        nodes: [
          { id: IDS.alice, x: 1, y: 2 },
          { id: IDS.bob, x: 3, y: 4 },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    };
    expect(savedViewGraphFilter(view)).toMatchObject({
      mode: "NEIGHBORHOOD",
      rootPersonIds: [IDS.alice],
      sensitivities: ["INTERNAL"],
    });
    expect(savedViewPositions(view)).toEqual([
      { id: IDS.alice, x: 1, y: 2 },
      { id: IDS.bob, x: 3, y: 4 },
    ]);
  });
});
