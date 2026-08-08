import { afterEach, describe, expect, it, vi } from "vitest";

import { clientEnvSchema } from "@/lib/env/client";
import {
  parseBootstrapAdminEnv,
  parseServerEnv,
  type ServerEnv,
} from "@/lib/env/server-schema";

const productionEnv = {
  NODE_ENV: "production",
  DEPLOYMENT_MODE: "vercel",
  NEXT_PUBLIC_APP_URL: "https://humans.example.com",
  DATABASE_URL:
    "postgresql://humans:Db9vN4xQ7kL2mR8sP5wT@db.example.com/humans?sslmode=require",
  REDIS_URL: "rediss://default:Rd8pL5vN2xQ9mK4sT7wC@redis.example.com:6379",
  REDIS_TOKEN: "Ur6xP3kM9vQ2tN8wL5sD",
  STORAGE_PROVIDER: "r2",
  STORAGE_ENDPOINT: "https://storage.example.com",
  STORAGE_REGION: "auto",
  STORAGE_BUCKET: "humans-private",
  STORAGE_ACCESS_KEY_ID: "example-access-key",
  STORAGE_SECRET_ACCESS_KEY: "S3nQ8vL2pR7xM4kT9wC6",
  STORAGE_FORCE_PATH_STYLE: "false",
  STORAGE_BUCKET_PUBLIC: "false",
  AUTH_SECRET: "mR7@qP2!vL9#cT4$xK8%wN3&zF6*Hg5A",
  AUTH_SECURE_COOKIES: "true",
  AUTH_TRUSTED_ORIGINS: "https://humans.example.com",
  AUTH_ENCRYPTION_KEY:
    "4a0c469d4318ba968207ac2c25bcbc6b100c4ab38da85b04fc151330bd71eb21",
  DATA_ENCRYPTION_KEY:
    "108d9c4e986953872f6447cf4927ae01d55914b9fb4d072a83fdb0f112810d5e",
  PROTECTED_LOOKUP_HMAC_KEY:
    "6b6c2529c2c0fbf61a3f385f826046c35282231cb40915ced7415cc6fbbcc08a",
  OPERATION_LIMIT_HMAC_KEY:
    "e116d9d4a0743fb123ecf20680928a64ed47e0e4bde9d0ea2d6d6c5d5ab3cfc9",
  TRUSTED_PROXY_MODE: "vercel",
  CRON_SECRET: "Cron!N7vQ2xL9mR4tK8wP5sD3cF6hJ0bE",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_USERNAME: "humans-admin",
  ADMIN_DISPLAY_NAME: "Humans Administrator",
  ADMIN_PASSWORD: "Frosted!Canyon7-Meteor$Lime",
  RESEND_API_KEY: "re_Mk7vP2xQ9nL4tR8wC5sD",
  EMAIL_FROM: "Humans <humans@example.com>",
  AI_PROVIDER: "openai",
  AI_BASE_URL: "https://api.openai.com/v1",
  AI_API_KEY: "sk-proj-N7vQ2xL9mR4tK8wP5sD3",
  AI_MODEL: "example-model",
} satisfies NodeJS.ProcessEnv;

describe("parseServerEnv", () => {
  it("parses the complete production environment", () => {
    const env = parseServerEnv(productionEnv);

    expect(env.DEPLOYMENT_MODE).toBe("vercel");
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(false);
    expect(env.AUTH_TRUSTED_ORIGINS).toEqual(["https://humans.example.com"]);
    expect(env.AUTH_REGISTRATION_MODE).toBe("invite_only");
    expect(env.TRUSTED_PROXY_MODE).toBe("vercel");
  });

  it("requires an explicit opt-in for public registration", () => {
    expect(
      parseServerEnv({
        ...productionEnv,
        AUTH_REGISTRATION_MODE: "public",
      }).AUTH_REGISTRATION_MODE,
    ).toBe("public");
  });

  it("canonicalizes and de-duplicates trusted HTTP origins in first-seen order", () => {
    const env = parseServerEnv({
      ...productionEnv,
      NEXT_PUBLIC_APP_URL: "HTTPS://HUMANS.EXAMPLE.COM:443/app/dashboard",
      AUTH_TRUSTED_ORIGINS:
        "  HTTP://FIRST.EXAMPLE.COM:80/path  , https://Humans.Example.Com:443/auth/callback/, http://first.example.com/duplicate, https://api.example.com:8443/v1, HTTPS://HUMANS.EXAMPLE.COM/another-path ",
    });

    expect(env.AUTH_TRUSTED_ORIGINS).toEqual([
      "http://first.example.com",
      "https://humans.example.com",
      "https://api.example.com:8443",
    ]);
    expect(env.NEXT_PUBLIC_APP_URL).toBe(
      "https://humans.example.com/app/dashboard",
    );
  });

  it.each([
    ["an empty entry", "https://humans.example.com,,https://other.example.com"],
    [
      "credentials",
      "https://humans.example.com,https://user:password@other.example.com",
    ],
    ["empty userinfo", "https://humans.example.com,https://@other.example.com"],
    [
      "a carriage return",
      "https://humans.example.com,https://oth\rer.example.com",
    ],
    ["a line feed", "https://humans.example.com,https://oth\ner.example.com"],
    ["a tab", "https://humans.example.com,https://oth\ter.example.com"],
    ["a NUL", "https://humans.example.com,https://other.example.com/\u0000"],
    ["a DEL", "https://humans.example.com,https://other.example.com/\u007f"],
    [
      "a non-HTTP protocol",
      "https://humans.example.com,ftp://other.example.com",
    ],
    ["a malformed URL", "https://humans.example.com,not an origin"],
  ])("rejects trusted origins containing %s", (_case, AUTH_TRUSTED_ORIGINS) => {
    expect(() =>
      parseServerEnv({ ...productionEnv, AUTH_TRUSTED_ORIGINS }),
    ).toThrow(/AUTH_TRUSTED_ORIGINS/);
  });

  it.each([
    ["credentials", "https://user:password@humans.example.com/app"],
    ["empty userinfo", "https://@humans.example.com/app"],
    ["a carriage return", "https://humans.ex\rample.com/app"],
    ["a line feed", "https://humans.ex\nample.com/app"],
    ["a tab", "https://humans.ex\tample.com/app"],
    ["a NUL", "https://humans.example.com/\u0000app"],
    ["a DEL", "https://humans.example.com/\u007fapp"],
    ["a non-HTTP protocol", "ftp://humans.example.com/app"],
  ])("rejects a production application URL containing %s", (_case, value) => {
    expect(() =>
      parseServerEnv({
        ...productionEnv,
        NEXT_PUBLIC_APP_URL: value,
      }),
    ).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it.each([
    "PROTECTED_LOOKUP_HMAC_KEY",
    "OPERATION_LIMIT_HMAC_KEY",
    "TRUSTED_PROXY_MODE",
  ] as const)("requires %s", (variable) => {
    const source: NodeJS.ProcessEnv = { ...productionEnv };
    delete source[variable];

    expect(() => parseServerEnv(source)).toThrow(new RegExp(variable));
  });

  it.each([
    ["vercel", "vercel", undefined],
    ["docker", "none", ""],
    [
      "docker",
      "hmac",
      "3410b7a577737048973a68df37498ed42cae7b28f16126db29f67691624d26cb",
    ],
  ] as const)(
    "permits %s deployment with %s proxy mode",
    (DEPLOYMENT_MODE, TRUSTED_PROXY_MODE, TRUSTED_PROXY_HMAC_KEY) => {
      const env = parseServerEnv({
        ...productionEnv,
        DEPLOYMENT_MODE,
        TRUSTED_PROXY_MODE,
        TRUSTED_PROXY_HMAC_KEY,
      });

      expect(env.TRUSTED_PROXY_MODE).toBe(TRUSTED_PROXY_MODE);
    },
  );

  it.each([
    ["docker", "vercel", undefined],
    ["vercel", "hmac", productionEnv.PROTECTED_LOOKUP_HMAC_KEY],
    ["docker", "hmac", undefined],
    ["docker", "none", productionEnv.PROTECTED_LOOKUP_HMAC_KEY],
  ] as const)(
    "rejects %s deployment with incompatible %s proxy configuration",
    (DEPLOYMENT_MODE, TRUSTED_PROXY_MODE, TRUSTED_PROXY_HMAC_KEY) => {
      expect(() =>
        parseServerEnv({
          ...productionEnv,
          DEPLOYMENT_MODE,
          TRUSTED_PROXY_MODE,
          TRUSTED_PROXY_HMAC_KEY,
        }),
      ).toThrow(/TRUSTED_PROXY_MODE/);
    },
  );

  it.each(["change-me", "replace-me", "secret", "0123456789abcdef"])(
    "rejects the placeholder production AUTH_SECRET %s",
    (AUTH_SECRET) => {
      expect(() => parseServerEnv({ ...productionEnv, AUTH_SECRET })).toThrow(
        /AUTH_SECRET/,
      );
    },
  );

  it("rejects a low-entropy production authentication credential", () => {
    expect(() =>
      parseServerEnv({ ...productionEnv, AUTH_SECRET: "a".repeat(32) }),
    ).toThrow(/AUTH_SECRET/);
  });

  it.each([
    ["AUTH_SECRET", { AUTH_SECRET: "example-auth-secret-example-auth-secret" }],
    [
      "AUTH_ENCRYPTION_KEY",
      {
        AUTH_ENCRYPTION_KEY:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    ],
    [
      "DATA_ENCRYPTION_KEY",
      {
        DATA_ENCRYPTION_KEY:
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      },
    ],
    [
      "PROTECTED_LOOKUP_HMAC_KEY",
      {
        PROTECTED_LOOKUP_HMAC_KEY:
          "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      },
    ],
    [
      "OPERATION_LIMIT_HMAC_KEY",
      {
        OPERATION_LIMIT_HMAC_KEY:
          "1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd",
      },
    ],
    ["AI_API_KEY", { AI_API_KEY: "sk-proj-examplevalueN7vQ2xL9mR4tK8" }],
    ["STORAGE_SECRET_ACCESS_KEY", { STORAGE_SECRET_ACCESS_KEY: "minioadmin" }],
    ["REDIS_TOKEN", { REDIS_TOKEN: "example-redis-token-value" }],
    [
      "DATABASE_URL",
      {
        DATABASE_URL:
          "postgresql://humans:abc123abc123abc123@db.example.com/humans",
      },
    ],
    [
      "REDIS_URL",
      {
        REDIS_URL:
          "rediss://default:12345678901234567890@redis.example.com:6379",
      },
    ],
  ] satisfies ReadonlyArray<
    readonly [string, Readonly<Record<string, string>>]
  >)(
    "rejects predictable production credential for %s",
    (variable, override) => {
      expect(() => parseServerEnv({ ...productionEnv, ...override })).toThrow(
        new RegExp(variable),
      );
    },
  );

  it("rejects insecure production cookies", () => {
    expect(() =>
      parseServerEnv({ ...productionEnv, AUTH_SECURE_COOKIES: "false" }),
    ).toThrow(/AUTH_SECURE_COOKIES/);
  });

  it("supports secure production cookies on the loopback application origin", () => {
    expect(() =>
      parseServerEnv({
        ...productionEnv,
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
        AUTH_SECURE_COOKIES: "true",
      }),
    ).not.toThrow();
  });

  it("requires independent auth signing and encryption keys", () => {
    const sharedKey = productionEnv.AUTH_ENCRYPTION_KEY;

    expect(() =>
      parseServerEnv({
        ...productionEnv,
        AUTH_SECRET: sharedKey,
        AUTH_ENCRYPTION_KEY: sharedKey,
      }),
    ).toThrow(
      /AUTH_ENCRYPTION_KEY.*AUTH_SECRET|AUTH_SECRET.*AUTH_ENCRYPTION_KEY/i,
    );
  });

  it("preserves mutual distinctness among existing production secrets", () => {
    expect(() =>
      parseServerEnv({
        ...productionEnv,
        CRON_SECRET: productionEnv.DATA_ENCRYPTION_KEY,
      }),
    ).toThrow(/Authentication, data, cron, and storage secrets must differ/);
  });

  it.each([
    "PROTECTED_LOOKUP_HMAC_KEY",
    "OPERATION_LIMIT_HMAC_KEY",
    "TRUSTED_PROXY_HMAC_KEY",
  ] as const)("requires %s to differ from every existing secret", (hmacKey) => {
    const hmacProxyEnv = {
      ...productionEnv,
      DEPLOYMENT_MODE: "docker",
      TRUSTED_PROXY_MODE: "hmac",
      TRUSTED_PROXY_HMAC_KEY:
        "3410b7a577737048973a68df37498ed42cae7b28f16126db29f67691624d26cb",
    };
    const sharedValue = hmacProxyEnv[hmacKey];
    const existingSecretOverrides: readonly Readonly<Record<string, string>>[] =
      [
        { AUTH_SECRET: sharedValue },
        { AUTH_ENCRYPTION_KEY: sharedValue },
        { DATA_ENCRYPTION_KEY: sharedValue },
        { CRON_SECRET: sharedValue },
        { STORAGE_SECRET_ACCESS_KEY: sharedValue },
        { RESEND_API_KEY: sharedValue },
        { REDIS_TOKEN: sharedValue },
        { AI_API_KEY: sharedValue },
        {
          DATABASE_URL: `postgresql://humans:${sharedValue}@db.example.com/humans?sslmode=require`,
        },
        {
          REDIS_URL: `rediss://default:${sharedValue}@redis.example.com:6379`,
        },
      ];

    for (const override of existingSecretOverrides) {
      expect(() => parseServerEnv({ ...hmacProxyEnv, ...override })).toThrow(
        new RegExp(hmacKey),
      );
    }
  });

  it("requires a production proxy HMAC key to be independent and unpredictable", () => {
    const hmacProxyEnv = {
      ...productionEnv,
      DEPLOYMENT_MODE: "docker",
      TRUSTED_PROXY_MODE: "hmac",
      TRUSTED_PROXY_HMAC_KEY:
        "3410b7a577737048973a68df37498ed42cae7b28f16126db29f67691624d26cb",
    };

    expect(() =>
      parseServerEnv({
        ...hmacProxyEnv,
        TRUSTED_PROXY_HMAC_KEY: "abcd".repeat(16),
      }),
    ).toThrow(/TRUSTED_PROXY_HMAC_KEY/);
    expect(() =>
      parseServerEnv({
        ...hmacProxyEnv,
        TRUSTED_PROXY_HMAC_KEY: productionEnv.DATA_ENCRYPTION_KEY,
      }),
    ).toThrow(/TRUSTED_PROXY_HMAC_KEY/);
  });

  it("rejects a public production object bucket", () => {
    expect(() =>
      parseServerEnv({ ...productionEnv, STORAGE_BUCKET_PUBLIC: "true" }),
    ).toThrow(/STORAGE_BUCKET_PUBLIC/);
  });

  it("rejects default production object-storage credentials", () => {
    expect(() =>
      parseServerEnv({
        ...productionEnv,
        STORAGE_ACCESS_KEY_ID: "minioadmin",
        STORAGE_SECRET_ACCESS_KEY: "minioadmin",
      }),
    ).toThrow(/STORAGE_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
  });

  it("does not require or expose bootstrap-only administrator credentials", () => {
    const source: NodeJS.ProcessEnv = { ...productionEnv };
    delete source.ADMIN_PASSWORD;

    const env = parseServerEnv(source);

    expect(env).not.toHaveProperty("ADMIN_EMAIL");
    expect(env).not.toHaveProperty("ADMIN_USERNAME");
    expect(env).not.toHaveProperty("ADMIN_DISPLAY_NAME");
    expect(env).not.toHaveProperty("ADMIN_PASSWORD");
  });

  it("requires an API key for the OpenAI provider", () => {
    expect(() =>
      parseServerEnv({ ...productionEnv, AI_API_KEY: undefined }),
    ).toThrow(/AI_API_KEY/);
  });

  it("maps the Vercel OpenRouter integration key for compatible providers", () => {
    const env = parseServerEnv({
      ...productionEnv,
      AI_PROVIDER: "compatible",
      AI_BASE_URL: "https://openrouter.ai/api/v1",
      AI_API_KEY: undefined,
      OPEN_ROUTER_KEY: "or-test-N7vQ2xL9mR4tK8wP5sD3",
    });

    expect(env.AI_API_KEY).toBe("or-test-N7vQ2xL9mR4tK8wP5sD3");
  });

  it("permits an Ollama endpoint without an API key", () => {
    const env = parseServerEnv({
      ...productionEnv,
      DEPLOYMENT_MODE: "docker",
      TRUSTED_PROXY_MODE: "none",
      AI_PROVIDER: "ollama",
      AI_BASE_URL: "http://ollama:11434/v1",
      AI_API_KEY: undefined,
    });

    expect(env.AI_PROVIDER).toBe("ollama");
  });

  it("canonicalizes provider base URLs", () => {
    expect(
      parseServerEnv({
        ...productionEnv,
        AI_PROVIDER: "compatible",
        AI_BASE_URL: "https://AI.EXAMPLE.COM:443/v1/",
      }).AI_BASE_URL,
    ).toBe("https://ai.example.com/v1");
  });

  it.each([
    ["openai", "https://other.example.com/v1"],
    ["openai", "http://api.openai.com/v1"],
    ["compatible", "http://ai.example.com/v1"],
    ["compatible", "https://user:pass@ai.example.com/v1"],
    ["compatible", "https://ai.example.com/v1?key=value"],
    ["compatible", "https://ai.example.com/v1#fragment"],
    ["compatible", "https://127.0.0.1/v1"],
    ["compatible", "https://10.0.0.1/v1"],
    ["compatible", "https://169.254.169.254/v1"],
    ["compatible", "https://224.0.0.1/v1"],
    ["compatible", "https://192.0.2.1/v1"],
    ["compatible", "https://198.18.0.1/v1"],
    ["compatible", "https://198.51.100.1/v1"],
    ["compatible", "https://203.0.113.1/v1"],
    ["compatible", "https://[2001:2::1]/v1"],
    ["compatible", "https://[2001:db8::1]/v1"],
    ["compatible", "https://[3fff::1]/v1"],
    ["compatible", "https://[5f00::1]/v1"],
    ["ollama", "http://remote.example.com:11434/v1"],
    ["ollama", "http://ollama:11434/not-v1"],
  ])("rejects unsafe %s provider URL %s", (AI_PROVIDER, AI_BASE_URL) => {
    expect(() =>
      parseServerEnv({ ...productionEnv, AI_PROVIDER, AI_BASE_URL }),
    ).toThrow(/AI_BASE_URL/);
  });

  it("permits loopback Ollama only in tests", () => {
    expect(
      parseServerEnv({
        ...productionEnv,
        NODE_ENV: "test",
        DEPLOYMENT_MODE: "docker",
        TRUSTED_PROXY_MODE: "none",
        AI_PROVIDER: "ollama",
        AI_BASE_URL: "http://127.0.0.1:11434/v1",
        AI_API_KEY: undefined,
      }).AI_BASE_URL,
    ).toBe("http://127.0.0.1:11434/v1");
  });
});

describe("parseBootstrapAdminEnv", () => {
  it("parses only explicit bootstrap administrator settings", () => {
    expect(parseBootstrapAdminEnv(productionEnv)).toEqual({
      ADMIN_EMAIL: productionEnv.ADMIN_EMAIL,
      ADMIN_USERNAME: productionEnv.ADMIN_USERNAME,
      ADMIN_DISPLAY_NAME: productionEnv.ADMIN_DISPLAY_NAME,
      ADMIN_PASSWORD: productionEnv.ADMIN_PASSWORD,
    });
  });

  it("trims and canonicalizes bootstrap identity values", () => {
    expect(
      parseBootstrapAdminEnv({
        ...productionEnv,
        ADMIN_EMAIL: "  Admin@Example.COM  ",
        ADMIN_USERNAME: "  Humans-Admin  ",
        ADMIN_DISPLAY_NAME: "  Humans Administrator  ",
      }),
    ).toMatchObject({
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_USERNAME: "humans-admin",
      ADMIN_DISPLAY_NAME: "Humans Administrator",
    });
  });

  it.each([
    ["ADMIN_EMAIL", "   "],
    ["ADMIN_USERNAME", "   "],
    ["ADMIN_DISPLAY_NAME", "   "],
  ])("rejects whitespace-only %s", (variable, value) => {
    expect(() =>
      parseBootstrapAdminEnv({ ...productionEnv, [variable]: value }),
    ).toThrow(new RegExp(variable));
  });

  it.each([
    ["missing", undefined],
    ["undersized", "short"],
    ["placeholder", "replace-with-a-password"],
    ["repeated", "a".repeat(24)],
    ["periodic", "abc123abc123abc123"],
  ])("rejects a %s bootstrap password", (_case, ADMIN_PASSWORD) => {
    expect(() =>
      parseBootstrapAdminEnv({ ...productionEnv, ADMIN_PASSWORD }),
    ).toThrow(/ADMIN_PASSWORD/);
  });
});

describe("getServerEnv", () => {
  afterEach(() => {
    vi.doUnmock("server-only");
    vi.resetModules();
  });

  it("enforces the server-only module boundary", async () => {
    vi.resetModules();
    vi.doUnmock("server-only");

    await expect(import("@/lib/env/server")).rejects.toThrow(
      /only be used from a Server Component/,
    );
  });

  it("parses explicitly injected sources without caching them", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { getServerEnv } = await import("@/lib/env/server");
    const typedAccessor: (source?: NodeJS.ProcessEnv) => ServerEnv =
      getServerEnv;

    const first = typedAccessor({ ...productionEnv, AI_MODEL: "first-model" });
    const second = typedAccessor({
      ...productionEnv,
      AI_MODEL: "second-model",
    });

    expect(first.AI_MODEL).toBe("first-model");
    expect(second.AI_MODEL).toBe("second-model");
    expect(second).not.toBe(first);
  });

  it("caches only the zero-argument process environment path", async () => {
    const originalProcessEnv = process.env;
    process.env = { ...productionEnv };
    vi.resetModules();
    vi.doMock("server-only", () => ({}));

    try {
      const { getServerEnv } = await import("@/lib/env/server");

      const injected = getServerEnv({
        ...productionEnv,
        AI_MODEL: "injected-model",
      });
      const firstDefault = getServerEnv();
      process.env.AI_MODEL = "changed-after-first-default";
      const secondDefault = getServerEnv();

      expect(injected.AI_MODEL).toBe("injected-model");
      expect(firstDefault.AI_MODEL).toBe("example-model");
      expect(secondDefault).toBe(firstDefault);
      expect(secondDefault.AI_MODEL).toBe("example-model");
    } finally {
      process.env = originalProcessEnv;
    }
  });
});

describe("clientEnvSchema", () => {
  it("accepts only a valid public application URL", () => {
    expect(
      clientEnvSchema.parse({
        NEXT_PUBLIC_APP_URL: "https://humans.example.com",
      }),
    ).toEqual({ NEXT_PUBLIC_APP_URL: "https://humans.example.com" });
    expect(() =>
      clientEnvSchema.parse({ NEXT_PUBLIC_APP_URL: "not-a-url" }),
    ).toThrow(/NEXT_PUBLIC_APP_URL/);
  });
});
