"use client";

import { Play, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { UploadPanel } from "@/components/files/upload-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { executeBrowserGraphQL } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  ImportWorkspaceItemFragmentDoc,
  PrepareWorkspaceImportDocument,
  RetryWorkspaceImportDocument,
  SaveWorkspaceImportMappingDocument,
  StartWorkspaceImportDocument,
  type FileWorkspaceItemFragment,
  type ImportFormat,
  type ImportWorkspaceItemFragment,
} from "@/graphql/generated/graphql";

type MappingOption = {
  definition: unknown;
  format: ImportFormat;
  id: string;
  name: string;
  version: number;
};

type PreparedImport = {
  import: ImportWorkspaceItemFragment;
  preview: readonly {
    issues: readonly { code: string | null; message: string | null }[] | null;
    normalizedPayload: unknown;
    rowNumber: number | null;
    state: string | null;
  }[];
};
type RecordKind = "PERSON" | "RELATIONSHIP";
type EndpointKind = "PERSON_ID" | "EXTERNAL_KEY";

function messageFromIssues(
  issues: readonly { message: string }[] | null | undefined,
): string | null {
  return issues?.[0]?.message ?? null;
}

function randomKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function ImportWizard({
  initialMappings,
}: {
  initialMappings: readonly MappingOption[];
}) {
  const router = useRouter();
  const [format, setFormat] = useState<ImportFormat>("CSV");
  const [mappings, setMappings] = useState([...initialMappings]);
  const compatible = useMemo(
    () => mappings.filter((mapping) => mapping.format === format),
    [format, mappings],
  );
  const [mappingId, setMappingId] = useState("");
  const [mappingName, setMappingName] = useState("People import");
  const [recordKind, setRecordKind] = useState<RecordKind>("PERSON");
  const [rowKeySource, setRowKeySource] = useState("external_id");
  const [displayNameSource, setDisplayNameSource] = useState("name");
  const [biographySource, setBiographySource] = useState("");
  const [preferredNameSource, setPreferredNameSource] = useState("");
  const [sortNameSource, setSortNameSource] = useState("");
  const [factDefinitionId, setFactDefinitionId] = useState("");
  const [factSource, setFactSource] = useState("");
  const [relationshipTypeId, setRelationshipTypeId] = useState("");
  const [sourceEndpointKind, setSourceEndpointKind] =
    useState<EndpointKind>("PERSON_ID");
  const [sourcePersonImportId, setSourcePersonImportId] = useState("");
  const [sourcePersonSource, setSourcePersonSource] =
    useState("source_person_id");
  const [targetEndpointKind, setTargetEndpointKind] =
    useState<EndpointKind>("PERSON_ID");
  const [targetPersonImportId, setTargetPersonImportId] = useState("");
  const [targetPersonSource, setTargetPersonSource] =
    useState("target_person_id");
  const [relationshipLabelSource, setRelationshipLabelSource] = useState("");
  const [file, setFile] = useState<FileWorkspaceItemFragment | null>(null);
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const prepareKey = useRef<string | null>(null);
  const startKey = useRef<string | null>(null);

  const effectiveMappingId = compatible.some(
    (mapping) => mapping.id === mappingId,
  )
    ? mappingId
    : "";

  async function saveMapping(): Promise<string | null> {
    setBusy(true);
    setStatus("Saving reusable mapping…");
    try {
      const result = await executeBrowserGraphQL(
        SaveWorkspaceImportMappingDocument,
        {
          input: {
            name: mappingName,
            format,
            definition:
              recordKind === "PERSON"
                ? {
                    version: 1,
                    recordKind,
                    rowKeySource,
                    person: {
                      displayNameSource,
                      primaryNameKind: "legal",
                      fields: [
                        ["biography", biographySource],
                        ["preferredName", preferredNameSource],
                        ["sortName", sortNameSource],
                      ].flatMap(([field, source]) =>
                        source ? [{ field, source }] : [],
                      ),
                    },
                    facts:
                      factDefinitionId && factSource
                        ? [
                            {
                              definitionId: factDefinitionId,
                              source: factSource,
                            },
                          ]
                        : [],
                    defaults: { sensitivity: "internal", status: "active" },
                  }
                : {
                    version: 1,
                    recordKind,
                    rowKeySource,
                    relationship: {
                      typeId: relationshipTypeId,
                      sourcePerson:
                        sourceEndpointKind === "PERSON_ID"
                          ? {
                              kind: sourceEndpointKind,
                              source: sourcePersonSource,
                            }
                          : {
                              kind: sourceEndpointKind,
                              personImportId: sourcePersonImportId,
                              source: sourcePersonSource,
                            },
                      targetPerson:
                        targetEndpointKind === "PERSON_ID"
                          ? {
                              kind: targetEndpointKind,
                              source: targetPersonSource,
                            }
                          : {
                              kind: targetEndpointKind,
                              personImportId: targetPersonImportId,
                              source: targetPersonSource,
                            },
                      fields: relationshipLabelSource
                        ? [
                            {
                              field: "labelOverride",
                              source: relationshipLabelSource,
                            },
                          ]
                        : [],
                    },
                    defaults: { sensitivity: "internal", state: "asserted" },
                  },
          },
        },
      );
      if (!result.ok) throw new Error(result.errors[0]?.message);
      const payload = result.data.saveImportMapping;
      const issue = messageFromIssues(payload?.issues);
      if (issue) throw new Error(issue);
      const saved = payload?.mapping;
      if (!saved?.id || !saved.name || !saved.format || saved.version == null) {
        throw new Error("The saved mapping response was incomplete.");
      }
      const option: MappingOption = {
        id: saved.id,
        name: saved.name,
        format: saved.format,
        definition: saved.definition,
        version: saved.version,
      };
      setMappings((current) => [
        option,
        ...current.filter((mapping) => mapping.id !== option.id),
      ]);
      setMappingId(option.id);
      setStatus("Mapping saved. You can now prepare the preview.");
      return option.id;
    } catch (error) {
      setStatus(
        error instanceof Error && error.message
          ? error.message
          : "The mapping could not be saved.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function prepare() {
    if (!file?.id || !effectiveMappingId) return;
    setBusy(true);
    setStatus("Parsing and validating the import…");
    try {
      const result = await executeBrowserGraphQL(
        PrepareWorkspaceImportDocument,
        {
          input: {
            fileId: file.id,
            mappingId: effectiveMappingId,
            idempotencyKey:
              prepareKey.current ?? (prepareKey.current = randomKey("prepare")),
            mode: "COMMIT",
          },
        },
      );
      if (!result.ok) throw new Error(result.errors[0]?.message);
      const payload = result.data.prepareImport;
      const issue = messageFromIssues(payload?.issues);
      if (issue) throw new Error(issue);
      const importRecord = readFragment(
        ImportWorkspaceItemFragmentDoc,
        payload?.import,
      );
      if (!importRecord?.id || importRecord.version == null) {
        throw new Error("The prepared import response was incomplete.");
      }
      setPrepared({
        import: importRecord,
        preview: payload?.preview ?? [],
      });
      setStatus(
        `Preview ready: ${importRecord.totalRows ?? 0} rows, ${importRecord.rejectedRows ?? 0} validation errors.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error && error.message
          ? error.message
          : "The import could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!prepared?.import.id || prepared.import.version == null) return;
    setBusy(true);
    setStatus("Queueing durable import execution…");
    try {
      const result = await executeBrowserGraphQL(StartWorkspaceImportDocument, {
        importId: prepared.import.id,
        expectedVersion: prepared.import.version,
        idempotencyKey:
          startKey.current ?? (startKey.current = randomKey("start")),
      });
      if (!result.ok) throw new Error(result.errors[0]?.message);
      const payload = result.data.startImport;
      const issue = messageFromIssues(payload?.issues);
      if (issue) throw new Error(issue);
      const queued = readFragment(
        ImportWorkspaceItemFragmentDoc,
        payload?.import,
      );
      if (!queued?.id) throw new Error("The queued import was not returned.");
      setStatus("Import queued. Its progress is now tracked below.");
      setPrepared(null);
      setFile(null);
      router.refresh();
    } catch (error) {
      setStatus(
        error instanceof Error && error.message
          ? error.message
          : "The import could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="import-wizard-heading" className="space-y-5">
      <div>
        <h2 id="import-wizard-heading" className="text-xl font-semibold">
          New people or relationship import
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Upload structured data, select a reusable field mapping, inspect the
          preview, then queue durable execution.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-4">
          <div className="border-border bg-card rounded-2xl border p-5">
            <label htmlFor="import-format" className="text-sm font-medium">
              Import format
            </label>
            <select
              id="import-format"
              value={format}
              disabled={busy}
              onChange={(event) => {
                setFormat(event.target.value as ImportFormat);
                setMappingId("");
                setFile(null);
                setPrepared(null);
                prepareKey.current = null;
                startKey.current = null;
              }}
              className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
            >
              <option value="CSV">CSV</option>
              <option value="JSON">JSON</option>
            </select>
          </div>
          <UploadPanel
            key={format}
            purpose={format === "CSV" ? "CSV_IMPORT" : "JSON_IMPORT"}
            onCompleted={(uploaded) => {
              setFile(uploaded);
              setPrepared(null);
              prepareKey.current = null;
              startKey.current = null;
              router.refresh();
            }}
          />
        </div>

        <div className="border-border bg-card rounded-2xl border p-5">
          <h3 className="font-semibold">Field mapping</h3>
          <label
            htmlFor="saved-mapping"
            className="mt-4 block text-sm font-medium"
          >
            Saved mapping
          </label>
          <select
            id="saved-mapping"
            value={effectiveMappingId}
            disabled={busy}
            onChange={(event) => {
              setMappingId(event.target.value);
              setPrepared(null);
              prepareKey.current = null;
              startKey.current = null;
            }}
            className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option value="">Create or select a mapping</option>
            {compatible.map((mapping) => (
              <option key={mapping.id} value={mapping.id}>
                {mapping.name}
              </option>
            ))}
          </select>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">
              Record kind
              <select
                className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                value={recordKind}
                disabled={busy}
                onChange={(event) =>
                  setRecordKind(event.target.value as RecordKind)
                }
              >
                <option value="PERSON">Person</option>
                <option value="RELATIONSHIP">Relationship</option>
              </select>
            </label>
            <label className="text-sm font-medium">
              Mapping name
              <Input
                className="mt-2"
                value={mappingName}
                disabled={busy}
                onChange={(event) => setMappingName(event.target.value)}
              />
            </label>
            <label className="text-sm font-medium">
              Stable row ID field
              <Input
                className="mt-2 font-mono"
                value={rowKeySource}
                disabled={busy}
                onChange={(event) => setRowKeySource(event.target.value)}
              />
            </label>
            {recordKind === "PERSON" ? (
              <>
                <label className="text-sm font-medium sm:col-span-2">
                  Display name source
                  <Input
                    className="mt-2 font-mono"
                    value={displayNameSource}
                    disabled={busy}
                    onChange={(event) =>
                      setDisplayNameSource(event.target.value)
                    }
                  />
                </label>
                <label className="text-sm font-medium">
                  Biography source (optional)
                  <Input
                    className="mt-2 font-mono"
                    value={biographySource}
                    disabled={busy}
                    onChange={(event) => setBiographySource(event.target.value)}
                  />
                </label>
                <label className="text-sm font-medium">
                  Preferred name source (optional)
                  <Input
                    className="mt-2 font-mono"
                    value={preferredNameSource}
                    disabled={busy}
                    onChange={(event) =>
                      setPreferredNameSource(event.target.value)
                    }
                  />
                </label>
                <label className="text-sm font-medium">
                  Sort name source (optional)
                  <Input
                    className="mt-2 font-mono"
                    value={sortNameSource}
                    disabled={busy}
                    onChange={(event) => setSortNameSource(event.target.value)}
                  />
                </label>
                <label className="text-sm font-medium">
                  Fact definition UUID (optional)
                  <Input
                    className="mt-2 font-mono"
                    value={factDefinitionId}
                    disabled={busy}
                    onChange={(event) =>
                      setFactDefinitionId(event.target.value)
                    }
                  />
                </label>
                <label className="text-sm font-medium">
                  Fact value source (optional)
                  <Input
                    className="mt-2 font-mono"
                    value={factSource}
                    disabled={busy}
                    onChange={(event) => setFactSource(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="text-sm font-medium sm:col-span-2">
                  Relationship type UUID
                  <Input
                    className="mt-2 font-mono"
                    value={relationshipTypeId}
                    disabled={busy}
                    onChange={(event) =>
                      setRelationshipTypeId(event.target.value)
                    }
                  />
                </label>
                <label className="text-sm font-medium">
                  Source endpoint kind
                  <select
                    className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                    value={sourceEndpointKind}
                    disabled={busy}
                    onChange={(event) =>
                      setSourceEndpointKind(event.target.value as EndpointKind)
                    }
                  >
                    <option value="PERSON_ID">Person UUID</option>
                    <option value="EXTERNAL_KEY">
                      Prior import external key
                    </option>
                  </select>
                </label>
                <label className="text-sm font-medium">
                  Source endpoint column
                  <Input
                    className="mt-2 font-mono"
                    value={sourcePersonSource}
                    disabled={busy}
                    onChange={(event) =>
                      setSourcePersonSource(event.target.value)
                    }
                  />
                </label>
                {sourceEndpointKind === "EXTERNAL_KEY" ? (
                  <label className="text-sm font-medium sm:col-span-2">
                    Source person import UUID
                    <Input
                      className="mt-2 font-mono"
                      value={sourcePersonImportId}
                      disabled={busy}
                      onChange={(event) =>
                        setSourcePersonImportId(event.target.value)
                      }
                    />
                  </label>
                ) : null}
                <label className="text-sm font-medium">
                  Target endpoint kind
                  <select
                    className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                    value={targetEndpointKind}
                    disabled={busy}
                    onChange={(event) =>
                      setTargetEndpointKind(event.target.value as EndpointKind)
                    }
                  >
                    <option value="PERSON_ID">Person UUID</option>
                    <option value="EXTERNAL_KEY">
                      Prior import external key
                    </option>
                  </select>
                </label>
                <label className="text-sm font-medium">
                  Target endpoint column
                  <Input
                    className="mt-2 font-mono"
                    value={targetPersonSource}
                    disabled={busy}
                    onChange={(event) =>
                      setTargetPersonSource(event.target.value)
                    }
                  />
                </label>
                {targetEndpointKind === "EXTERNAL_KEY" ? (
                  <label className="text-sm font-medium sm:col-span-2">
                    Target person import UUID
                    <Input
                      className="mt-2 font-mono"
                      value={targetPersonImportId}
                      disabled={busy}
                      onChange={(event) =>
                        setTargetPersonImportId(event.target.value)
                      }
                    />
                  </label>
                ) : null}
                <label className="text-sm font-medium sm:col-span-2">
                  Relationship label source (optional)
                  <Input
                    className="mt-2 font-mono"
                    value={relationshipLabelSource}
                    disabled={busy}
                    onChange={(event) =>
                      setRelationshipLabelSource(event.target.value)
                    }
                  />
                </label>
              </>
            )}
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void saveMapping()}
            >
              Save mapping
            </Button>
            <Button
              type="button"
              disabled={busy || !file?.id || !effectiveMappingId}
              onClick={() => void prepare()}
            >
              Prepare preview
            </Button>
          </div>
          <p className="text-muted-foreground mt-4 text-xs" aria-live="polite">
            {status ??
              (file?.originalName
                ? `${file.originalName} is ready for mapping.`
                : "Upload a file and choose a mapping.")}
          </p>
        </div>
      </div>

      {prepared ? (
        <div className="border-border rounded-2xl border p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold">Validated preview</h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {prepared.import.totalRows ?? 0} total rows;{" "}
                {prepared.import.rejectedRows ?? 0} currently rejected.
              </p>
            </div>
            <Button type="button" disabled={busy} onClick={() => void start()}>
              <Play aria-hidden="true" data-icon="inline-start" />
              Start import
            </Button>
          </div>
          <div className="border-border mt-4 max-h-96 overflow-auto rounded-xl border">
            <Table aria-label="Import preview">
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Normalized data</TableHead>
                  <TableHead>Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prepared.preview.map((row, index) => (
                  <TableRow key={`${row.rowNumber ?? index}-${index}`}>
                    <TableCell>{row.rowNumber ?? index + 1}</TableCell>
                    <TableCell>{row.state ?? "unknown"}</TableCell>
                    <TableCell>
                      <pre className="max-w-xl overflow-x-auto text-xs">
                        {JSON.stringify(row.normalizedPayload, null, 2)}
                      </pre>
                    </TableCell>
                    <TableCell>
                      {row.issues
                        ?.map((issue) => issue.message)
                        .filter(Boolean)
                        .join("; ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function RetryImportButton({
  importId,
  version,
}: {
  importId: string;
  version: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const retryKey = useRef<string | null>(null);
  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await executeBrowserGraphQL(
              RetryWorkspaceImportDocument,
              {
                importId,
                expectedVersion: version,
                idempotencyKey:
                  retryKey.current ?? (retryKey.current = randomKey("retry")),
              },
            );
            if (!result.ok) throw new Error(result.errors[0]?.message);
            const issue = messageFromIssues(result.data.retryImport?.issues);
            if (issue) throw new Error(issue);
            setStatus("Retry queued.");
            router.refresh();
          } catch (error) {
            setStatus(
              error instanceof Error && error.message
                ? error.message
                : "Retry failed.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <RotateCcw aria-hidden="true" data-icon="inline-start" />
        {busy ? "Queueing…" : "Retry"}
      </Button>
      {status ? (
        <p className="text-muted-foreground mt-1 text-xs" aria-live="polite">
          {status}
        </p>
      ) : null}
    </div>
  );
}
