import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("modular monolith boundary", () => {
  it("keeps client modules free of server, database, and repository imports", () => {
    const forbiddenImports = [
      /from\s+["']@\/db(?:\/|["'])/u,
      /from\s+["']@\/modules\/(?!auth\/(?:auth-client|return-to)(?:["']|\/)|graph\/(?:types|transform|export)(?:["']|\/))/u,
      /from\s+["']@\/graphql\/server(?:["']|\/)/u,
      /from\s+["']@\/lib\/(?:env\/server|auth\/config|network\/client-address)/u,
      /from\s+["']@\/lib\/(?:security|storage\/s3)(?:\/|["'])/u,
      /from\s+["']server-only["']/u,
      /\bexecuteServerGraphQL\b/u,
    ];

    const clientFiles = sourceFiles(join(sourceRoot, "app"))
      .concat(sourceFiles(join(sourceRoot, "components")))
      .filter((path) => /^\s*["']use client["'];/mu.test(read(path)));

    expect(clientFiles.length).toBeGreaterThan(0);
    for (const path of clientFiles) {
      const contents = read(path);
      for (const pattern of forbiddenImports) {
        expect(
          contents,
          `${relative(process.cwd(), path)} crossed the browser/server boundary`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("routes browser data access through the generated GraphQL client", () => {
    const client = read(join(sourceRoot, "graphql/client.ts"));
    expect(client).toContain('fetch("/api/graphql"');
    expect(client).toContain("TypedDocumentString");

    const browserModules = sourceFiles(join(sourceRoot, "components"))
      .filter((path) => /^\s*["']use client["'];/mu.test(read(path)))
      .filter((path) => /executeBrowserGraphQL/u.test(read(path)));

    expect(browserModules.length).toBeGreaterThan(0);
    for (const path of browserModules) {
      const contents = read(path);
      expect(contents).toMatch(/@\/graphql\/generated\//u);
    }
  });

  it("uses the same domain-service factories from GraphQL and worker runtimes", () => {
    const graphqlContext = read(join(sourceRoot, "graphql/context.ts"));
    const workerRuntime = read(join(sourceRoot, "worker/runtime.ts"));
    const sharedFactories = [
      "createPeopleService",
      "createEvidenceService",
      "createGraphService",
      "createSearchService",
    ];

    for (const factory of sharedFactories) {
      expect(graphqlContext).toContain(factory);
      expect(workerRuntime).toContain(factory);
    }
  });
});
