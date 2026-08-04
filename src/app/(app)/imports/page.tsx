import Link from "next/link";

import { getAppContext } from "@/app/(app)/app-session";
import {
  ImportWizard,
  RetryImportButton,
} from "@/components/imports/import-wizard";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  ImportHistoryDocument,
  ImportMappingOptionsDocument,
  ImportRowDiagnosticsDocument,
  ImportWorkspaceItemFragmentDoc,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { readOpaqueCursor } from "@/lib/research-pagination";

const retryableStates = new Set([
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "DEAD_LETTER",
]);

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const params = await searchParams;
  const after = readOpaqueCursor(params.after);
  const diagnosticsId =
    typeof params.diagnostics === "string" &&
    /^[0-9a-f-]{36}$/iu.test(params.diagnostics)
      ? params.diagnostics
      : null;
  const [data, mappingData] = await Promise.all([
    executeServerGraphQL(ImportHistoryDocument, { first: 20, after }),
    executeServerGraphQL(ImportMappingOptionsDocument, {}),
  ]);
  const imports =
    readFragment(ImportWorkspaceItemFragmentDoc, data.imports?.nodes) ?? [];
  const mappings = (mappingData.importMappings?.nodes ?? []).flatMap(
    (mapping) =>
      mapping.id && mapping.name && mapping.format && mapping.version != null
        ? [
            {
              id: mapping.id,
              name: mapping.name,
              format: mapping.format,
              definition: mapping.definition,
              version: mapping.version,
            },
          ]
        : [],
  );
  const diagnostics = diagnosticsId
    ? await executeServerGraphQL(ImportRowDiagnosticsDocument, {
        importId: diagnosticsId,
        first: 100,
      })
    : null;
  const permissions = context.viewer.permissions;
  const canCreate = [
    "file:create",
    "import:create",
    "import:run",
    "person:create",
  ].every((permission) => permissions.includes(permission));
  const canRetry = permissions.includes("import:run");
  const pageInfo = data.imports?.pageInfo;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-primary text-sm font-semibold">Data ingestion</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Imports</h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
          Map structured files into durable people, facts, and relationships
          with row-level validation and resumable execution.
        </p>
      </header>

      {canCreate ? <ImportWizard initialMappings={mappings} /> : null}

      <section aria-labelledby="import-history-heading">
        <div className="mb-4">
          <h2 id="import-history-heading" className="text-xl font-semibold">
            Import history
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Totals are refreshed from terminal row outcomes and never inferred
            from a worker response.
          </p>
        </div>
        <div className="border-border overflow-x-auto rounded-2xl border">
          <Table aria-label="Workspace imports">
            <TableHeader>
              <TableRow>
                <TableHead>Import</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Accepted</TableHead>
                <TableHead>Rejected</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.flatMap((item) =>
                item.id
                  ? [
                      <TableRow key={item.id}>
                        <TableCell>
                          <p className="font-mono text-xs">{item.id}</p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {item.format ?? "Unknown format"}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge>{item.state ?? "UNKNOWN"}</Badge>
                        </TableCell>
                        <TableCell>{item.totalRows ?? 0}</TableCell>
                        <TableCell>{item.acceptedRows ?? 0}</TableCell>
                        <TableCell>{item.rejectedRows ?? 0}</TableCell>
                        <TableCell>
                          {item.updatedAt
                            ? new Date(item.updatedAt).toLocaleString()
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={`/imports?diagnostics=${encodeURIComponent(item.id)}`}
                              className={buttonVariants({
                                size: "sm",
                                variant: "outline",
                              })}
                            >
                              View rows
                            </Link>
                            {canRetry &&
                            item.version != null &&
                            item.state &&
                            retryableStates.has(item.state) ? (
                              <RetryImportButton
                                importId={item.id}
                                version={item.version}
                              />
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>,
                    ]
                  : [],
              )}
              {imports.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <p className="font-medium">No imports yet</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Upload a CSV or JSON file to create a validated preview.
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        {pageInfo?.hasNextPage && pageInfo.endCursor ? (
          <div className="mt-4 flex justify-end">
            <Link
              href={`/imports?after=${encodeURIComponent(pageInfo.endCursor)}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Next imports
            </Link>
          </div>
        ) : null}
      </section>

      {diagnosticsId && diagnostics ? (
        <section aria-labelledby="import-diagnostics-heading">
          <h2 id="import-diagnostics-heading" className="text-xl font-semibold">
            Row diagnostics
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Import <span className="font-mono">{diagnosticsId}</span>
          </p>
          <div className="border-border mt-4 max-h-[36rem] overflow-auto rounded-2xl border">
            <Table aria-label="Import row diagnostics">
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Issues</TableHead>
                  <TableHead>Result references</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(diagnostics.importRows?.nodes ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.rowNumber}</TableCell>
                    <TableCell>
                      <Badge>{row.state}</Badge>
                    </TableCell>
                    <TableCell>
                      {row.issues?.map((issue) => issue.message).join("; ") ||
                        "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.resultReferences?.join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
