"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import { useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toRelationshipEditorGraph } from "@/modules/graph/transform";
import type { GraphResult } from "@/modules/graph/types";

type EditorNode = Node<{ label: string }, "person">;
type EditorEdge = Edge<{ relationshipId: string; version: number }>;

export type RelationshipEditorMutationAdapter = {
  archive?: (input: {
    expectedVersion: number;
    relationshipId: string;
  }) => Promise<boolean>;
  create?: (input: {
    relationshipTypeId: string;
    sensitivity: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
    sourcePersonId: string;
    targetPersonId: string;
  }) => Promise<boolean>;
  update?: (input: {
    expectedVersion: number;
    relationshipId: string;
    sensitivity: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  }) => Promise<boolean>;
};

export type RelationshipTypeOption = { id: string; label: string };

function PersonNode({ data }: NodeProps<EditorNode>) {
  return (
    <div className="border-primary bg-card text-foreground min-w-40 rounded-xl border-2 px-4 py-3 text-center text-sm font-semibold shadow-md">
      <Handle
        id="target"
        type="target"
        position={Position.Left}
        aria-label={`Connect a relationship to ${data.label}`}
      />
      {data.label}
      <Handle
        id="source"
        type="source"
        position={Position.Right}
        aria-label={`Connect a relationship from ${data.label}`}
      />
    </div>
  );
}

const NODE_TYPES = { person: PersonNode };

export function RelationshipEditor({
  focusId,
  mutationAdapter,
  onClose,
  onMutationComplete,
  relationshipTypes,
  relationshipTypesTruncated = false,
  result,
}: {
  focusId: string;
  mutationAdapter?: RelationshipEditorMutationAdapter;
  onClose: () => void;
  onMutationComplete?: () => void;
  relationshipTypes?: readonly RelationshipTypeOption[];
  relationshipTypesTruncated?: boolean;
  result: GraphResult;
}) {
  const editor = useMemo(
    () => toRelationshipEditorGraph(result, focusId),
    [focusId, result],
  );
  const editorNodeIds = useMemo(
    () => new Set(editor.nodes.map((node) => node.id)),
    [editor.nodes],
  );
  const editorEdgeIds = useMemo(
    () => new Set(editor.edges.map((edge) => edge.id)),
    [editor.edges],
  );
  const relationships = useMemo(
    () =>
      new Map(
        result.edges
          .filter((edge) => editorEdgeIds.has(edge.id))
          .map((edge) => [edge.id, edge]),
      ),
    [editorEdgeIds, result.edges],
  );
  const people = useMemo(
    () =>
      new Map(
        result.nodes
          .filter((node) => editorNodeIds.has(node.id))
          .map((node) => [node.id, node.displayName]),
      ),
    [editorNodeIds, result.nodes],
  );
  const [nodes, setNodes] = useState<EditorNode[]>(() =>
    editor.nodes.map((node) => ({
      ...node,
      type: "person",
      ariaLabel: `Person ${node.data.label}. Use arrow keys to move this local view position.`,
      focusable: true,
    })),
  );
  const [edges, setEdges] = useState<EditorEdge[]>(() =>
    editor.edges.map((edge) => {
      const relationship = relationships.get(edge.id)!;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        ariaLabel: `${edge.label} relationship from ${people.get(edge.source)} to ${people.get(edge.target)}, version ${relationship.version}`,
        data: {
          relationshipId: relationship.relationshipId,
          version: relationship.version,
        },
        focusable: true,
        reconnectable: false,
        markerEnd: relationship.directed
          ? { type: MarkerType.ArrowClosed }
          : undefined,
      };
    }),
  );
  const typeOptions = useMemo(() => {
    const options = new Map(
      (relationshipTypes ?? []).map((option) => [option.id, option]),
    );
    for (const edge of result.edges.filter((edge) =>
      editorEdgeIds.has(edge.id),
    )) {
      if (!options.has(edge.relationshipTypeId)) {
        options.set(edge.relationshipTypeId, {
          id: edge.relationshipTypeId,
          label: edge.forwardLabel,
        });
      }
    }
    return [...options.values()].sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    );
  }, [editorEdgeIds, relationshipTypes, result.edges]);
  const [sourcePersonId, setSourcePersonId] = useState(focusId);
  const [targetPersonId, setTargetPersonId] = useState("");
  const [relationshipTypeId, setRelationshipTypeId] = useState(
    typeOptions[0]?.id ?? "",
  );
  const [createSensitivity, setCreateSensitivity] = useState<
    "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED"
  >("INTERNAL");
  const [selectedRelationshipId, setSelectedRelationshipId] = useState("");
  const selectedRelationship = selectedRelationshipId
    ? relationships.get(selectedRelationshipId)
    : undefined;
  const [existingSensitivity, setExistingSensitivity] = useState<
    "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED"
  >("INTERNAL");
  const [pendingChange, setPendingChange] = useState<
    | { kind: "archive"; edge: EditorEdge }
    | {
        kind: "update";
        edge: EditorEdge;
        sensitivity: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
      }
    | null
  >(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");

  const onNodesChange: OnNodesChange<EditorNode> = (changes) =>
    setNodes((current) => applyNodeChanges(changes, current));
  const onEdgesChange: OnEdgesChange<EditorEdge> = (changes) =>
    setEdges((current) =>
      applyEdgeChanges(
        changes.filter((change) => change.type !== "remove"),
        current,
      ),
    );
  async function createRelationship() {
    if (
      !sourcePersonId ||
      !targetPersonId ||
      !relationshipTypeId ||
      !editorNodeIds.has(sourcePersonId) ||
      !editorNodeIds.has(targetPersonId) ||
      !typeOptions.some((option) => option.id === relationshipTypeId) ||
      !mutationAdapter?.create ||
      pending
    )
      return;
    setPending(true);
    const saved = await mutationAdapter.create({
      sourcePersonId,
      targetPersonId,
      relationshipTypeId,
      sensitivity: createSensitivity,
    });
    setPending(false);
    if (saved) {
      setStatus("Relationship saved. Refreshing the canonical graph.");
      onMutationComplete?.();
    } else {
      setStatus("Relationship was not saved.");
    }
  }

  async function confirmChange() {
    if (!pendingChange || !mutationAdapter || pending) return;
    setPending(true);
    const expectedVersion = pendingChange.edge.data?.version;
    const relationshipId = pendingChange.edge.data?.relationshipId;
    if (expectedVersion === undefined || !relationshipId) {
      setPending(false);
      setStatus("The relationship version is unavailable; no change was sent.");
      return;
    }
    const saved =
      pendingChange.kind === "archive"
        ? await mutationAdapter.archive?.({ expectedVersion, relationshipId })
        : await mutationAdapter.update?.({
            expectedVersion,
            relationshipId,
            sensitivity: pendingChange.sensitivity,
          });
    setPending(false);
    if (saved) {
      setPendingChange(null);
      setStatus("Relationship changed. Refreshing the canonical graph.");
      onMutationComplete?.();
    } else {
      setStatus("Relationship was not changed.");
    }
  }

  function chooseExistingRelationship(id: string) {
    setSelectedRelationshipId(id);
    setPendingChange(null);
    const relationship = relationships.get(id);
    if (relationship) {
      setExistingSensitivity(
        relationship.sensitivity.toUpperCase() as typeof existingSensitivity,
      );
    }
  }

  function selectedEditorEdge() {
    return edges.find((edge) => edge.id === selectedRelationshipId);
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="h-[min(92svh,54rem)] w-[min(96vw,78rem)] max-w-none overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <DialogTitle>Edit neighborhood</DialogTitle>
            <DialogDescription>
              One hop around {people.get(focusId) ?? "the selected person"}.
              Dragging changes only saved-view positions. Dropping a connection
              opens a form and never writes automatically.
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            aria-label="Close relationship editor"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
        {editor.truncated ? (
          <p className="border-disputed/50 bg-disputed/10 border-b px-5 py-3 text-sm">
            The editor is limited to 100 people and 250 relationships. Continue
            in the tables for every loaded element.
          </p>
        ) : null}
        <div className="grid h-[calc(100%-5.5rem)] min-h-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-h-[24rem]">
            <ReactFlow<EditorNode, EditorEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              fitView
              nodesFocusable
              edgesFocusable
              edgesReconnectable={false}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={(next) => {
                setSourcePersonId(next.source);
                setTargetPersonId(next.target);
                setStatus(
                  "Complete the relationship form. No relationship has been written.",
                );
              }}
              onEdgeClick={(_, edge) => chooseExistingRelationship(edge.id)}
              onBeforeDelete={async ({ edges: deletingEdges }) => {
                const edge = deletingEdges[0];
                if (edge) {
                  chooseExistingRelationship(edge.id);
                  setPendingChange({ kind: "archive", edge });
                  setStatus("Confirm relationship archival before saving.");
                }
                return false;
              }}
              aria-label="Focused relationship editor"
              ariaLabelConfig={{
                "controls.ariaLabel": "Relationship editor controls",
                "controls.fitView.ariaLabel": "Fit neighborhood",
                "controls.interactive.ariaLabel":
                  "Toggle neighborhood interaction",
                "controls.zoomIn.ariaLabel": "Zoom into neighborhood",
                "controls.zoomOut.ariaLabel": "Zoom out of neighborhood",
                "handle.ariaLabel": "Relationship connection handle",
              }}
            >
              <Background />
              <Controls aria-label="Relationship editor controls" />
            </ReactFlow>
          </div>
          <aside
            className="border-border overflow-y-auto border-t p-5 lg:border-t-0 lg:border-l"
            aria-label="Relationship change review"
          >
            <h3 className="font-semibold">Review changes</h3>
            <p
              role="status"
              aria-live="polite"
              className="text-muted-foreground mt-2 min-h-10 text-sm"
            >
              {status ||
                "Select a connection or relationship. Nothing is written from the canvas alone."}
            </p>
            <div className="mt-5 space-y-4">
              <h4 className="text-sm font-semibold">New relationship</h4>
              {relationshipTypesTruncated ? (
                <p className="text-muted-foreground text-xs">
                  The type selector contains the first 25 active catalog types
                  plus every type in this authorized neighborhood.
                </p>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="editor-relationship-source">Source</Label>
                <select
                  id="editor-relationship-source"
                  aria-label="Relationship source"
                  value={sourcePersonId}
                  onChange={(event) => setSourcePersonId(event.target.value)}
                  className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
                >
                  {editor.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.data.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="editor-relationship-target">Target</Label>
                <select
                  id="editor-relationship-target"
                  aria-label="Relationship target"
                  value={targetPersonId}
                  onChange={(event) => setTargetPersonId(event.target.value)}
                  className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
                >
                  <option value="">Choose a person</option>
                  {editor.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.data.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="editor-relationship-type">
                  Relationship type
                </Label>
                <select
                  id="editor-relationship-type"
                  aria-label="Relationship type"
                  value={relationshipTypeId}
                  onChange={(event) =>
                    setRelationshipTypeId(event.target.value)
                  }
                  className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
                >
                  {typeOptions.length === 0 ? (
                    <option value="">No active type is available</option>
                  ) : null}
                  {typeOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="editor-relationship-sensitivity">
                  Sensitivity
                </Label>
                <select
                  id="editor-relationship-sensitivity"
                  value={createSensitivity}
                  onChange={(event) =>
                    setCreateSensitivity(
                      event.target.value as typeof createSensitivity,
                    )
                  }
                  className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
                >
                  <option>PUBLIC</option>
                  <option>INTERNAL</option>
                  <option>CONFIDENTIAL</option>
                  <option>RESTRICTED</option>
                </select>
              </div>
              <Button
                type="button"
                className="w-full"
                disabled={
                  !mutationAdapter?.create ||
                  !sourcePersonId ||
                  !targetPersonId ||
                  !relationshipTypeId ||
                  pending
                }
                onClick={createRelationship}
              >
                {pending ? "Saving…" : "Create relationship"}
              </Button>
              {!mutationAdapter?.create ? (
                <p className="text-muted-foreground text-xs">
                  Relationship creation is unavailable for this viewer. No data
                  was changed.
                </p>
              ) : null}
            </div>
            <div className="border-border mt-6 space-y-4 border-t pt-5">
              <h4 className="text-sm font-semibold">Existing relationship</h4>
              <div className="space-y-2">
                <Label htmlFor="editor-existing-relationship">
                  Relationship
                </Label>
                <select
                  id="editor-existing-relationship"
                  aria-label="Existing relationship"
                  value={selectedRelationshipId}
                  onChange={(event) =>
                    chooseExistingRelationship(event.target.value)
                  }
                  className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
                >
                  <option value="">Choose a relationship</option>
                  {editor.edges.map((editorEdge) => {
                    const edge = relationships.get(editorEdge.id);
                    return edge ? (
                      <option key={edge.id} value={edge.id}>
                        {people.get(edge.source)} — {edge.forwardLabel} —{" "}
                        {people.get(edge.target)}
                      </option>
                    ) : null;
                  })}
                </select>
              </div>
              {selectedRelationship ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="editor-existing-sensitivity">
                      Sensitivity
                    </Label>
                    <select
                      id="editor-existing-sensitivity"
                      aria-label="Existing relationship sensitivity"
                      value={existingSensitivity}
                      onChange={(event) =>
                        setExistingSensitivity(
                          event.target.value as typeof existingSensitivity,
                        )
                      }
                      className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
                    >
                      <option>PUBLIC</option>
                      <option>INTERNAL</option>
                      <option>CONFIDENTIAL</option>
                      <option>RESTRICTED</option>
                    </select>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!mutationAdapter?.update || pending}
                      onClick={() => {
                        const edge = selectedEditorEdge();
                        if (!edge) return;
                        setPendingChange({
                          kind: "update",
                          edge,
                          sensitivity: existingSensitivity,
                        });
                        setStatus(
                          "Confirm the relationship update before saving.",
                        );
                      }}
                    >
                      Review update
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!mutationAdapter?.archive || pending}
                      onClick={() => {
                        const edge = selectedEditorEdge();
                        if (!edge) return;
                        setPendingChange({ kind: "archive", edge });
                        setStatus(
                          "Confirm relationship archival before saving.",
                        );
                      }}
                    >
                      Review archive
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
            {pendingChange ? (
              <div className="border-border bg-muted mt-5 rounded-xl border p-4">
                <p className="text-sm font-semibold">
                  {pendingChange.kind === "archive"
                    ? "Archive relationship?"
                    : "Update relationship?"}
                </p>
                <p className="text-muted-foreground mt-2 text-xs">
                  The request will include expected version{" "}
                  {pendingChange.edge.data?.version}. The canonical graph
                  changes only after server success.
                </p>
                <div className="mt-4 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    aria-label={`Confirm ${pendingChange.kind}`}
                    disabled={
                      pending ||
                      (pendingChange.kind === "archive"
                        ? !mutationAdapter?.archive
                        : !mutationAdapter?.update)
                    }
                    onClick={confirmChange}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setPendingChange(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
