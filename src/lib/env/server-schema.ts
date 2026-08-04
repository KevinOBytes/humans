import { z } from "zod";

import { canonicalizeHttpOrigin } from "@/lib/security/http-origin.server";
import { canonicalizeAiBaseUrl } from "@/modules/ai/types";

const documentationValuePattern =
  /(?:^|[-_.:/])(?:change[-_]?me|replace[-_]?(?:me|with)|example|sample|placeholder|dummy|fake|test[-_]?only|your[-_][a-z0-9]+)(?=$|[-_.:/])/i;
const documentationMarkers = [
  "changeme",
  "replaceme",
  "replacewith",
  "example",
  "sample",
  "placeholder",
  "dummy",
  "minioadmin",
];

function normalizePatternInput(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasPeriodicPattern(value: string): boolean {
  const normalized = normalizePatternInput(value);
  if (normalized.length < 12) return false;

  for (let period = 1; period <= normalized.length / 3; period += 1) {
    if (normalized.length % period !== 0) continue;
    const unit = normalized.slice(0, period);
    if (unit.repeat(normalized.length / period) === normalized) return true;
  }

  return false;
}

function hasSequentialPattern(value: string): boolean {
  const normalized = normalizePatternInput(value);
  let runLength = 1;
  let priorStep = 0;

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    const sameClass =
      (/\d/.test(previous) && /\d/.test(current)) ||
      (/[a-z]/.test(previous) && /[a-z]/.test(current));
    const step = current.charCodeAt(0) - previous.charCodeAt(0);

    if (sameClass && (step === 1 || step === -1) && step === priorStep) {
      runLength += 1;
    } else if (sameClass && (step === 1 || step === -1)) {
      runLength = 2;
    } else {
      runLength = 1;
    }

    priorStep = sameClass ? step : 0;
    if (runLength >= 6) return true;
  }

  return false;
}

function getProductionSecretProblem(
  value: string,
  minimumLength: number,
): string | undefined {
  const trimmed = value.trim();
  const normalized = normalizePatternInput(trimmed);

  if (trimmed.length < minimumLength) {
    return `must contain at least ${minimumLength} characters`;
  }
  if (
    documentationValuePattern.test(trimmed) ||
    documentationMarkers.some((marker) => normalized.includes(marker)) ||
    ["secret", "password", "admin"].includes(normalized)
  ) {
    return "contains a documentation, example, or default value";
  }
  if (hasPeriodicPattern(trimmed)) {
    return "contains an obvious repeated or periodic pattern";
  }
  if (hasSequentialPattern(trimmed)) {
    return "contains an obvious sequential pattern";
  }

  return undefined;
}

function addProductionSecretIssue(
  context: z.RefinementCtx,
  path: string,
  value: string | undefined,
  minimumLength: number,
): void {
  if (!value) return;
  const problem = getProductionSecretProblem(value, minimumLength);
  if (!problem) return;

  context.addIssue({
    code: "custom",
    path: [path],
    message: `${path} ${problem}`,
  });
}

const booleanFromString = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const trustedOrigins = z
  .string()
  .transform((value, context) => {
    const origins = new Set<string>();
    for (const entry of value.split(",")) {
      const origin = canonicalizeHttpOrigin(entry);
      if (!origin) {
        context.addIssue({
          code: "custom",
          message:
            "AUTH_TRUSTED_ORIGINS entries must be valid HTTP(S) URLs without credentials",
        });
        return z.NEVER;
      }
      origins.add(origin);
    }
    return [...origins];
  })
  .pipe(z.array(z.string()).min(1));

const applicationUrl = z.string().transform((value, context) => {
  if (!canonicalizeHttpOrigin(value)) {
    context.addIssue({
      code: "custom",
      message:
        "NEXT_PUBLIC_APP_URL must be a valid HTTP(S) URL without credentials",
    });
    return z.NEVER;
  }
  return new URL(value.trim()).href;
});

const commonServerEnv = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  NEXT_PUBLIC_APP_URL: applicationUrl,
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  REDIS_TOKEN: z.string().optional(),
  STORAGE_PROVIDER: z.enum(["minio", "r2", "s3"]),
  STORAGE_ENDPOINT: z.url(),
  STORAGE_REGION: z.string().min(1),
  STORAGE_BUCKET: z.string().min(3),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanFromString,
  STORAGE_BUCKET_PUBLIC: booleanFromString,
  AUTH_SECRET: z.string().min(16),
  AUTH_SECURE_COOKIES: booleanFromString,
  AUTH_TRUSTED_ORIGINS: trustedOrigins,
  AUTH_REGISTRATION_MODE: z
    .enum(["disabled", "invite_only", "public"])
    .default("invite_only"),
  AUTH_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  PROTECTED_LOOKUP_HMAC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  OPERATION_LIMIT_HMAC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  TRUSTED_PROXY_MODE: z.enum(["none", "vercel", "hmac"]),
  TRUSTED_PROXY_HMAC_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  CRON_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().min(1),
  RESEND_BASE_URL: z.url().optional(),
  EMAIL_FROM: z.string().regex(/^(?:[^<>]+\s+)?<[^<>\s]+@[^<>\s]+>$/),
  AI_PROVIDER: z.enum(["openai", "ollama", "compatible"]),
  AI_BASE_URL: z.string().min(1),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().min(1),
});

export const serverEnvSchema = z
  .discriminatedUnion("DEPLOYMENT_MODE", [
    commonServerEnv.extend({ DEPLOYMENT_MODE: z.literal("vercel") }),
    commonServerEnv.extend({ DEPLOYMENT_MODE: z.literal("docker") }),
  ])
  .superRefine((env, context) => {
    if (env.AUTH_ENCRYPTION_KEY === env.AUTH_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_ENCRYPTION_KEY"],
        message: "AUTH_ENCRYPTION_KEY must differ from AUTH_SECRET",
      });
    }

    if (env.RESEND_BASE_URL) {
      const resendUrl = new URL(env.RESEND_BASE_URL);
      if (
        env.NODE_ENV !== "test" ||
        resendUrl.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "::1"].includes(resendUrl.hostname)
      ) {
        context.addIssue({
          code: "custom",
          path: ["RESEND_BASE_URL"],
          message: "RESEND_BASE_URL is restricted to loopback test runtimes",
        });
      }
    }

    if (
      (env.TRUSTED_PROXY_MODE === "vercel" &&
        env.DEPLOYMENT_MODE !== "vercel") ||
      (env.TRUSTED_PROXY_MODE === "hmac" &&
        (env.DEPLOYMENT_MODE !== "docker" || !env.TRUSTED_PROXY_HMAC_KEY)) ||
      (env.TRUSTED_PROXY_MODE !== "hmac" && env.TRUSTED_PROXY_HMAC_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["TRUSTED_PROXY_MODE"],
        message:
          "Trusted proxy mode does not match the deployment configuration",
      });
    }

    if (env.AI_PROVIDER !== "ollama" && !env.AI_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["AI_API_KEY"],
        message: `AI_API_KEY is required for the ${env.AI_PROVIDER} provider`,
      });
    }

    try {
      env.AI_BASE_URL = canonicalizeAiBaseUrl({
        provider: env.AI_PROVIDER,
        baseUrl: env.AI_BASE_URL,
        apiKey: env.AI_API_KEY,
        nodeEnv: env.NODE_ENV,
      });
    } catch {
      context.addIssue({
        code: "custom",
        path: ["AI_BASE_URL"],
        message: "AI_BASE_URL is not allowed for the configured AI provider",
      });
    }

    if (env.STORAGE_PROVIDER === "minio" && !env.STORAGE_FORCE_PATH_STYLE) {
      context.addIssue({
        code: "custom",
        path: ["STORAGE_FORCE_PATH_STYLE"],
        message: "MinIO requires path-style storage access",
      });
    }
    if (env.STORAGE_PROVIDER === "r2") {
      if (env.STORAGE_FORCE_PATH_STYLE) {
        context.addIssue({
          code: "custom",
          path: ["STORAGE_FORCE_PATH_STYLE"],
          message: "R2 does not use MinIO path-style behavior",
        });
      }
      if (env.STORAGE_REGION !== "auto") {
        context.addIssue({
          code: "custom",
          path: ["STORAGE_REGION"],
          message: "R2 requires the auto region alias",
        });
      }
    }

    if (env.NODE_ENV !== "production") return;

    if (env.DEPLOYMENT_MODE === "vercel" && !env.CRON_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["CRON_SECRET"],
        message: "CRON_SECRET is required for Vercel job execution",
      });
    }

    if (!env.AUTH_SECURE_COOKIES) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_SECURE_COOKIES"],
        message: "AUTH_SECURE_COOKIES must be true in production",
      });
    }

    if (env.STORAGE_BUCKET_PUBLIC) {
      context.addIssue({
        code: "custom",
        path: ["STORAGE_BUCKET_PUBLIC"],
        message: "STORAGE_BUCKET_PUBLIC must be false in production",
      });
    }

    for (const [path, value, minimumLength] of [
      ["AUTH_SECRET", env.AUTH_SECRET, 32],
      ["AUTH_ENCRYPTION_KEY", env.AUTH_ENCRYPTION_KEY, 64],
      ["DATA_ENCRYPTION_KEY", env.DATA_ENCRYPTION_KEY, 64],
      ["PROTECTED_LOOKUP_HMAC_KEY", env.PROTECTED_LOOKUP_HMAC_KEY, 64],
      ["OPERATION_LIMIT_HMAC_KEY", env.OPERATION_LIMIT_HMAC_KEY, 64],
      ["TRUSTED_PROXY_HMAC_KEY", env.TRUSTED_PROXY_HMAC_KEY, 64],
      ["CRON_SECRET", env.CRON_SECRET, 32],
      ["STORAGE_SECRET_ACCESS_KEY", env.STORAGE_SECRET_ACCESS_KEY, 16],
      ["RESEND_API_KEY", env.RESEND_API_KEY, 16],
      ["REDIS_TOKEN", env.REDIS_TOKEN, 16],
    ] as const) {
      addProductionSecretIssue(context, path, value, minimumLength);
    }

    if (env.AI_PROVIDER !== "ollama") {
      addProductionSecretIssue(context, "AI_API_KEY", env.AI_API_KEY, 16);
    }

    const mutuallyDistinctExistingSecrets = [
      env.AUTH_SECRET,
      env.AUTH_ENCRYPTION_KEY,
      env.DATA_ENCRYPTION_KEY,
      env.CRON_SECRET,
      env.STORAGE_SECRET_ACCESS_KEY,
    ].filter((value): value is string => Boolean(value));
    if (
      new Set(mutuallyDistinctExistingSecrets).size !==
      mutuallyDistinctExistingSecrets.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["CRON_SECRET"],
        message: "Authentication, data, cron, and storage secrets must differ",
      });
    }

    const existingSecrets = [
      env.AUTH_SECRET,
      env.AUTH_ENCRYPTION_KEY,
      env.DATA_ENCRYPTION_KEY,
      env.CRON_SECRET,
      env.STORAGE_SECRET_ACCESS_KEY,
      env.RESEND_API_KEY,
      env.REDIS_TOKEN,
      env.AI_API_KEY,
      decodeURIComponent(new URL(env.DATABASE_URL).password),
      decodeURIComponent(new URL(env.REDIS_URL).password),
    ].filter((value): value is string => Boolean(value));

    const hmacSecrets = [
      ["PROTECTED_LOOKUP_HMAC_KEY", env.PROTECTED_LOOKUP_HMAC_KEY],
      ["OPERATION_LIMIT_HMAC_KEY", env.OPERATION_LIMIT_HMAC_KEY],
      ["TRUSTED_PROXY_HMAC_KEY", env.TRUSTED_PROXY_HMAC_KEY],
    ] as const;
    for (const [path, value] of hmacSecrets) {
      if (!value) continue;
      const duplicatesAnotherHmac = hmacSecrets.some(
        ([otherPath, otherValue]) =>
          otherPath !== path &&
          otherValue !== undefined &&
          otherValue === value,
      );
      if (!duplicatesAnotherHmac && !existingSecrets.includes(value)) continue;

      context.addIssue({
        code: "custom",
        path: [path],
        message: `${path} must differ from every other application secret`,
      });
    }

    for (const [path, rawUrl] of [
      ["DATABASE_URL", env.DATABASE_URL],
      ["REDIS_URL", env.REDIS_URL],
    ] as const) {
      const password = decodeURIComponent(new URL(rawUrl).password);
      if (password) addProductionSecretIssue(context, path, password, 16);
    }

    const applicationOrigin = canonicalizeHttpOrigin(env.NEXT_PUBLIC_APP_URL)!;
    if (!env.AUTH_TRUSTED_ORIGINS.includes(applicationOrigin)) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_TRUSTED_ORIGINS"],
        message: "AUTH_TRUSTED_ORIGINS must include NEXT_PUBLIC_APP_URL",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const bootstrapAdminEnvSchema = z
  .object({
    ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
    ADMIN_USERNAME: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    ADMIN_DISPLAY_NAME: z.string().trim().min(1).max(100),
    ADMIN_PASSWORD: z.string().min(16),
  })
  .superRefine((env, context) => {
    addProductionSecretIssue(context, "ADMIN_PASSWORD", env.ADMIN_PASSWORD, 16);
  });

export type BootstrapAdminEnv = z.infer<typeof bootstrapAdminEnvSchema>;

export function parseServerEnv(source: NodeJS.ProcessEnv): ServerEnv {
  return serverEnvSchema.parse(source);
}

export function parseBootstrapAdminEnv(
  source: NodeJS.ProcessEnv,
): BootstrapAdminEnv {
  return bootstrapAdminEnvSchema.parse(source);
}
