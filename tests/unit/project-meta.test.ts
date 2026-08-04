import { describe, expect, it } from "vitest";
import { PROJECT_META } from "@/lib/project-meta";

describe("PROJECT_META", () => {
  it("declares both supported deployment modes", () => {
    expect(PROJECT_META).toEqual({
      name: "Humans",
      deploymentModes: ["vercel", "docker"],
    });
  });
});
