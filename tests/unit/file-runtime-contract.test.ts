// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("file upload runtime wiring", () => {
  it("threads deployment mode into the production file runtime and server UI limits", () => {
    const route = readFileSync("src/app/api/graphql/route.ts", "utf8");
    const evidence = readFileSync("src/app/(app)/evidence/page.tsx", "utf8");
    const imports = readFileSync("src/app/(app)/imports/page.tsx", "utf8");

    expect(route).toContain("deploymentMode: env.DEPLOYMENT_MODE");
    expect(evidence).toContain("uploadMaxBytesForDeployment");
    expect(evidence).toContain("maxBytes={uploadMaxBytes}");
    expect(imports).toContain("uploadMaxBytesForDeployment");
    expect(imports).toContain("uploadMaxBytesByFormat");
  });
});
