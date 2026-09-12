import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sourceCustodyEvents, sources } from "@/db/schema";

describe("source provenance contract", () => {
  it("keeps publication, collector, and extraction fields first-class", () => {
    expect(sources.publicationDate).toBeDefined();
    expect(sources.collector).toBeDefined();
    expect(sources.extractionMethod).toBeDefined();
  });

  it("keeps custody events tenant-bound and append-only by shape", () => {
    const config = getTableConfig(sourceCustodyEvents);
    expect(
      config.foreignKeys.map((foreignKey) => foreignKey.getName()),
    ).toContain("source_custody_events_workspace_source_fk");
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "workspace_id",
        "source_id",
        "event_kind",
        "occurred_at",
        "collector",
        "integrity_hash",
        "metadata",
        "created_by",
      ]),
    );
    expect(config.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "source_custody_events_kind_check",
        "source_custody_events_text_check",
      ]),
    );
    expect(config.columns.map((column) => column.name)).not.toContain(
      "updated_at",
    );
    const migration = readFileSync("drizzle/0039_core.sql", "utf8");
    expect(migration).toContain("source_custody_events_immutable_update");
    expect(migration).toContain("source custody events are immutable");
  });
});
