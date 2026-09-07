import { describe, expect, it, vi } from "vitest";
import {
  createPersonResearchService,
  createBravePersonSearch,
} from "@/modules/people/research";
import type { AiProvider } from "@/modules/ai/types";
import type { PermissionKey } from "@/modules/auth/permissions";

const personId = "019fe224-a0cd-76e4-92ac-9d28795c2cca";
const workspaceId = "019fe224-a0cd-76e4-92ac-9d27a5c62cf4";
const sources = [
  {
    url: "https://example.org/profile",
    title: "Public profile",
    snippet: "Ada is a researcher.",
  },
];
const suggestion = {
  field: "biography",
  value: "Ada is a researcher.",
  sourceUrls: [sources[0]!.url],
};
const permissions: PermissionKey[] = [
  "person:read",
  "analysis:create",
  "analysis:run",
];

function setup(
  options: {
    permissions?: PermissionKey[];
    sensitivity?: string;
    missing?: boolean;
    foreign?: boolean;
    configured?: boolean;
    answer?: unknown;
    sources?: unknown;
  } = {},
) {
  const search = vi.fn<
    (query: string, signal: AbortSignal) => Promise<unknown>
  >(async () => options.sources ?? sources);
  const generate = vi.fn<AiProvider["generate"]>(async () => ({
    type: "answer" as const,
    answer: JSON.stringify(options.answer ?? { suggestions: [suggestion] }),
    citations: [],
  }));
  const provider: AiProvider = {
    disclosure: { provider: "OLLAMA", model: "test-model" },
    baseUrlFingerprint: "fingerprint",
    generate,
  };
  const person = {
    id: personId,
    workspaceId: options.foreign ? "other" : workspaceId,
    displayName: "Ada",
    preferredName: null,
    sortName: null,
    biography: "Do not disclose internal biography",
    sensitivity: options.sensitivity ?? "internal",
  };
  const service = createPersonResearchService({
    workspaceId,
    permissions: new Set(options.permissions ?? permissions),
    loadPerson: async () => (options.missing ? null : person),
    operationLimiter: {
      consume: async () => ({
        allowed: true,
        remainingMicrotokens: 1,
        retryAfterMs: 0,
      }),
    },
    runtime:
      options.configured === false
        ? undefined
        : { search: { search }, provider },
  });
  return { service, search, generate };
}

describe("person web research", () => {
  it("returns source-backed drafts without sending internal biography", async () => {
    const { service, generate, search } = setup();
    expect(await service.run({ personId, consent: true })).toMatchObject({
      personId,
      suggestions: [suggestion],
      sources,
    });
    expect(search.mock.calls[0]).toEqual(["Ada", expect.any(AbortSignal)]);
    expect(JSON.stringify(generate.mock.calls)).not.toContain(
      "Do not disclose internal biography",
    );
  });
  it.each(permissions)(
    "requires %s before contacting either provider",
    async (permission) => {
      const { service, search, generate } = setup({
        permissions: permissions.filter((value) => value !== permission),
      });
      await expect(
        service.run({ personId, consent: true }),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect(search).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    },
  );
  it.each([{ missing: true }, { foreign: true }])(
    "does not disclose unavailable people",
    async (options) => {
      const { service, search } = setup(options);
      await expect(
        service.run({ personId, consent: true }),
      ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
      expect(search).not.toHaveBeenCalled();
    },
  );
  it.each(["confidential", "restricted"])(
    "does not send %s records externally",
    async (sensitivity) => {
      const { service, search } = setup({ sensitivity });
      await expect(
        service.run({ personId, consent: true }),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect(search).not.toHaveBeenCalled();
    },
  );
  it("requires explicit disclosure consent", async () => {
    const { service, search } = setup();
    await expect(
      service.run({ personId, consent: false }),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    expect(search).not.toHaveBeenCalled();
  });
  it("fails with stable configuration guidance when disabled", async () => {
    await expect(
      setup({ configured: false }).service.run({ personId, consent: true }),
    ).rejects.toMatchObject({
      message:
        "Web research is not configured. Ask an administrator to enable it.",
      extensions: { code: "PROVIDER_UNAVAILABLE" },
    });
  });
  it.each([
    { suggestions: [{ ...suggestion, field: "sex" }] },
    {
      suggestions: [
        { ...suggestion, sourceUrls: ["https://invented.example.org/"] },
      ],
    },
    { suggestions: [{ ...suggestion, sourceUrls: [] }] },
    { suggestions: [{ ...suggestion, value: "a".repeat(4001) }] },
    { suggestions: [suggestion, suggestion] },
    { suggestions: [suggestion], secret: "extra" },
  ])("rejects unsafe or unsupported model suggestions", async (answer) => {
    await expect(
      setup({ answer }).service.run({ personId, consent: true }),
    ).rejects.toMatchObject({ extensions: { code: "PROVIDER_UNAVAILABLE" } });
  });
  it.each([
    "javascript:alert(1)",
    "http://127.0.0.1/profile",
    "https://user:password@example.org/",
    "https://metadata.google.internal/",
  ])("rejects unsafe source URL %s", async (url) => {
    await expect(
      setup({ sources: [{ ...sources[0], url }] }).service.run({
        personId,
        consent: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PROVIDER_UNAVAILABLE" } });
  });
  it("uses Brave's fixed endpoint and rejects redirects", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  url: sources[0]!.url,
                  title: sources[0]!.title,
                  description: sources[0]!.snippet,
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = createBravePersonSearch({ apiKey: "test-key", fetcher });
    expect(await adapter.search("Ada", new AbortController().signal)).toEqual(
      sources,
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "api.search.brave.com" }),
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          "X-Subscription-Token": "test-key",
        }),
      }),
    );
  });
});
