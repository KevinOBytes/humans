"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  CreateGraphViewInput,
  GraphViewSharing,
  UpdateGraphViewInput,
} from "@/graphql/generated/graphql";
import type { GraphPosition, GraphResult } from "@/modules/graph/types";

export type GraphSavedViewSummary = {
  id: string;
  name: string;
  sharing: GraphViewSharing;
  updatedAt?: string | null;
  version: number;
};

export type GraphSavedViewRun = {
  layoutAlgorithm?: "CIRCLE" | "FORCE_ATLAS_2";
  positionPageInfo?: GraphSavedViewPageInfo;
  positions?: readonly GraphPosition[];
  result: GraphResult;
  view: GraphSavedViewSummary;
};

export type GraphSavedViewPageInfo = {
  endCursor: string | null;
  hasNextPage: boolean;
};

export type GraphSavedViewListPage = {
  nodes: readonly GraphSavedViewSummary[];
  pageInfo: GraphSavedViewPageInfo;
};

export type GraphSavedPositionPage = {
  pageInfo: GraphSavedViewPageInfo;
  positions: readonly GraphPosition[];
};

export type GraphSavedViewAdapter = {
  archive(input: { expectedVersion: number; id: string }): Promise<boolean>;
  create(input: CreateGraphViewInput): Promise<GraphSavedViewSummary | null>;
  list(after?: string): Promise<GraphSavedViewListPage>;
  loadPositions?(
    id: string,
    after: string,
  ): Promise<GraphSavedPositionPage | null>;
  run(id: string): Promise<GraphSavedViewRun | null>;
  update(input: UpdateGraphViewInput): Promise<GraphSavedViewSummary | null>;
};

export function GraphSavedViews({
  adapter,
  canArchive,
  canCreate,
  canUpdate,
  capture,
  initialView,
  initialViewId,
  onRun,
  onStatus,
  workspaceIdentity,
}: {
  adapter: GraphSavedViewAdapter;
  canArchive: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  capture: () => Omit<CreateGraphViewInput, "name" | "sharing">;
  initialView?: GraphSavedViewSummary | null;
  initialViewId?: string | null;
  onRun: (view: GraphSavedViewRun) => void;
  onStatus: (message: string) => void;
  workspaceIdentity: string;
}) {
  const generationRef = useRef(0);
  const requestEpochRef = useRef(0);
  const [views, setViews] = useState<readonly GraphSavedViewSummary[]>([]);
  const [selectedId, setSelectedId] = useState(initialViewId ?? "");
  const selected = useMemo(
    () => views.find((view) => view.id === selectedId),
    [selectedId, views],
  );
  const [name, setName] = useState("Graph view");
  const [sharing, setSharing] = useState<GraphViewSharing>("PRIVATE");
  const [pending, setPending] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [listPageInfo, setListPageInfo] = useState<GraphSavedViewPageInfo>({
    endCursor: null,
    hasNextPage: false,
  });
  const [loadedRun, setLoadedRun] = useState<GraphSavedViewRun | null>(null);
  const [seenListCursors, setSeenListCursors] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [seenPositionCursors, setSeenPositionCursors] = useState<
    ReadonlySet<string>
  >(new Set());
  const [stateSource, setStateSource] = useState({
    adapter,
    initialView,
    initialViewId,
    workspaceIdentity,
  });

  if (
    stateSource.adapter !== adapter ||
    stateSource.initialView !== initialView ||
    stateSource.initialViewId !== initialViewId ||
    stateSource.workspaceIdentity !== workspaceIdentity
  ) {
    setStateSource({ adapter, initialView, initialViewId, workspaceIdentity });
    setViews([]);
    setSelectedId("");
    setName("Graph view");
    setSharing("PRIVATE");
    setConfirmArchive(false);
    setListPageInfo({ endCursor: null, hasNextPage: false });
    setLoadedRun(null);
    setSeenListCursors(new Set());
    setSeenPositionCursors(new Set());
    setPending(false);
  }

  useLayoutEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, [adapter, initialView, initialViewId, onStatus, workspaceIdentity]);

  function beginRequest() {
    requestEpochRef.current += 1;
    return requestEpochRef.current;
  }

  function isCurrent(generation: number, requestEpoch: number) {
    return (
      generation === generationRef.current &&
      requestEpoch === requestEpochRef.current
    );
  }

  useEffect(() => {
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    adapter
      .list()
      .then((page) => {
        if (!isCurrent(generation, requestEpoch)) return;
        if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
          throw new Error("Saved graph view pagination omitted its cursor.");
        }
        if (
          new Set(page.nodes.map((view) => view.id)).size !== page.nodes.length
        ) {
          throw new Error("Saved graph view pagination repeated a view.");
        }
        const listed =
          initialView && !page.nodes.some((view) => view.id === initialView.id)
            ? [initialView, ...page.nodes]
            : page.nodes;
        setViews(listed);
        setListPageInfo(page.pageInfo);
        setSeenListCursors(
          page.pageInfo.endCursor
            ? new Set([page.pageInfo.endCursor])
            : new Set(),
        );
        const initial = listed.find((view) => view.id === initialViewId);
        if (initial) {
          setSelectedId(initial.id);
          setName(initial.name);
          setSharing(initial.sharing);
        }
      })
      .catch(() => {
        if (isCurrent(generation, requestEpoch)) {
          onStatus("Saved graph views could not be listed.");
        }
      });
  }, [adapter, initialView, initialViewId, onStatus, workspaceIdentity]);

  function choose(id: string) {
    beginRequest();
    setSelectedId(id);
    setConfirmArchive(false);
    setLoadedRun(null);
    setSeenPositionCursors(new Set());
    setPending(false);
    const view = views.find((candidate) => candidate.id === id);
    if (view) {
      setName(view.name);
      setSharing(view.sharing);
    }
  }

  function upsert(view: GraphSavedViewSummary) {
    setViews((current) =>
      [...current.filter((candidate) => candidate.id !== view.id), view].sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      ),
    );
    setSelectedId(view.id);
    setName(view.name);
    setSharing(view.sharing);
  }

  async function create() {
    if (pending || !canCreate || !name.trim()) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const view = await adapter.create({
        ...capture(),
        name: name.trim(),
        sharing,
      });
      if (!isCurrent(generation, requestEpoch)) return;
      if (!view) return onStatus("Graph view was not saved.");
      upsert(view);
      onStatus("Graph view saved.");
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Graph view could not be saved.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function update() {
    if (pending || !canUpdate || !selected || !name.trim()) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const view = await adapter.update({
        ...capture(),
        id: selected.id,
        expectedVersion: selected.version,
        name: name.trim(),
        sharing,
      });
      if (!isCurrent(generation, requestEpoch)) return;
      if (!view) return onStatus("Graph view was not updated.");
      upsert(view);
      onStatus("Graph view updated.");
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Graph view could not be updated.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function archive() {
    if (pending || !canArchive || !selected || !confirmArchive) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const archived = await adapter.archive({
        id: selected.id,
        expectedVersion: selected.version,
      });
      if (!isCurrent(generation, requestEpoch)) return;
      if (!archived) return onStatus("Graph view was not archived.");
      setViews((current) => current.filter((view) => view.id !== selected.id));
      setSelectedId("");
      setConfirmArchive(false);
      setLoadedRun(null);
      onStatus("Graph view archived.");
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Graph view could not be archived.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function run() {
    if (pending || !selected) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    onStatus("Loading the selected saved view.");
    try {
      const loaded = await adapter.run(selected.id);
      if (!isCurrent(generation, requestEpoch)) return;
      if (!loaded) return onStatus("The saved graph view was not found.");
      if (
        loaded.positionPageInfo?.hasNextPage &&
        !loaded.positionPageInfo.endCursor
      ) {
        throw new Error("Saved graph position pagination omitted its cursor.");
      }
      setLoadedRun(loaded);
      setSeenPositionCursors(
        loaded.positionPageInfo?.endCursor
          ? new Set([loaded.positionPageInfo.endCursor])
          : new Set(),
      );
      onRun(loaded);
      onStatus(
        loaded.positionPageInfo?.hasNextPage
          ? "Saved graph view loaded. More saved position pages are available."
          : "Saved graph view loaded from authorized data.",
      );
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Saved graph view could not be loaded.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function loadMoreViews() {
    if (pending || !listPageInfo.hasNextPage || !listPageInfo.endCursor) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const page = await adapter.list(listPageInfo.endCursor);
      if (!isCurrent(generation, requestEpoch)) return;
      if (
        (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
        (page.pageInfo.endCursor &&
          seenListCursors.has(page.pageInfo.endCursor))
      ) {
        throw new Error("Saved graph view pagination did not advance.");
      }
      const pageIds = new Set(page.nodes.map((view) => view.id));
      if (
        pageIds.size !== page.nodes.length ||
        views.some((view) => pageIds.has(view.id))
      ) {
        throw new Error("Saved graph view pagination repeated a view.");
      }
      if (page.pageInfo.endCursor) {
        setSeenListCursors(
          (current) => new Set([...current, page.pageInfo.endCursor!]),
        );
      }
      setViews((current) =>
        [...current, ...page.nodes].sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        ),
      );
      setListPageInfo(page.pageInfo);
      onStatus(
        page.pageInfo.hasNextPage
          ? "More saved graph views loaded. Additional pages remain."
          : "All saved graph views are loaded.",
      );
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("More saved graph views could not be loaded.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function loadMorePositions() {
    const pageInfo = loadedRun?.positionPageInfo;
    if (
      pending ||
      !loadedRun ||
      !adapter.loadPositions ||
      !pageInfo?.hasNextPage ||
      !pageInfo.endCursor
    )
      return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const page = await adapter.loadPositions(
        loadedRun.view.id,
        pageInfo.endCursor,
      );
      if (!isCurrent(generation, requestEpoch)) return;
      if (!page) return onStatus("The saved graph view was not found.");
      if (
        (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
        (page.pageInfo.endCursor &&
          seenPositionCursors.has(page.pageInfo.endCursor))
      ) {
        throw new Error("Saved graph position pagination did not advance.");
      }
      if (page.pageInfo.endCursor) {
        setSeenPositionCursors(
          (current) => new Set([...current, page.pageInfo.endCursor!]),
        );
      }
      const merged = new Map(
        (loadedRun.positions ?? []).map((position) => [position.id, position]),
      );
      for (const position of page.positions) {
        if (merged.has(position.id)) {
          throw new Error("Saved graph position pagination repeated a person.");
        }
        merged.set(position.id, position);
      }
      const nextRun = {
        ...loadedRun,
        positionPageInfo: page.pageInfo,
        positions: [...merged.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      };
      setLoadedRun(nextRun);
      onRun(nextRun);
      onStatus(
        page.pageInfo.hasNextPage
          ? "More saved positions loaded. Additional pages remain."
          : "All saved positions are loaded.",
      );
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("More saved positions could not be loaded.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function copyLink() {
    if (!selected) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    try {
      const url = new URL(
        `/graph?view=${encodeURIComponent(selected.id)}`,
        window.location.origin,
      );
      await navigator.clipboard.writeText(url.toString());
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Saved view link copied.");
      }
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Saved view link could not be copied.");
      }
    }
  }

  return (
    <section
      aria-labelledby="saved-graph-views-heading"
      className="border-border bg-card rounded-2xl border p-4 shadow-sm"
    >
      <h2 id="saved-graph-views-heading" className="font-semibold">
        Saved graph views
      </h2>
      <p className="text-muted-foreground mt-1 text-xs">
        Names, sharing, filters, and positions persist only after an authorized
        save. Local graph state is not placed in the URL or browser storage.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div>
          <Label htmlFor="saved-graph-view">Saved view</Label>
          <select
            id="saved-graph-view"
            className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
            value={selectedId}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">Choose a saved view</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name} ({view.sharing.toLocaleLowerCase()})
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="graph-view-name">View name</Label>
          <Input
            id="graph-view-name"
            className="mt-2"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="graph-view-sharing">Sharing</Label>
          <select
            id="graph-view-sharing"
            className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
            value={sharing}
            onChange={(event) =>
              setSharing(event.target.value as GraphViewSharing)
            }
          >
            <option value="PRIVATE">Private</option>
            <option value="WORKSPACE">Workspace</option>
          </select>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {listPageInfo.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending || !listPageInfo.endCursor}
            onClick={loadMoreViews}
          >
            Load more saved views
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={pending || !canCreate || !name.trim()}
          onClick={create}
        >
          Save new view
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !selected}
          onClick={run}
        >
          Run selected view
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !canUpdate || !selected || !name.trim()}
          onClick={update}
        >
          Update selected view
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !selected}
          onClick={copyLink}
        >
          Copy selected view link
        </Button>
        {canArchive && selected ? (
          confirmArchive ? (
            <>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={archive}
              >
                Confirm archive view
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setConfirmArchive(false)}
              >
                Cancel archive
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmArchive(true)}
            >
              Archive selected view
            </Button>
          )
        ) : null}
        {loadedRun?.positionPageInfo?.hasNextPage ? (
          adapter.loadPositions ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending || !loadedRun.positionPageInfo.endCursor}
              onClick={loadMorePositions}
            >
              Load more saved positions
            </Button>
          ) : (
            <p className="text-muted-foreground basis-full text-xs">
              More saved position pages exist, but this client cannot load them.
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}
