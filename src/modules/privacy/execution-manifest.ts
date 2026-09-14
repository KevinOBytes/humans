import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { privacyProcessors } from "./request-types";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const executionContractSchema = z
  .object({
    version: z.literal(1),
    action: z.enum(["soft_delete", "hard_delete", "anonymize"]),
    binding: digest,
    policies: z
      .array(
        z
          .object({
            id: z.string(),
            version: z.number().int().positive(),
            hash: digest,
          })
          .strict(),
      )
      .max(2),
    policyHash: digest,
    legalBasisDigest: digest,
    processorCapabilityVersion: z.literal(1),
    requiredProcessors: z.array(z.enum(privacyProcessors)).length(5),
  })
  .strict();
export type PrivacyExecutionContract = z.infer<typeof executionContractSchema>;

export function privacyExecutionDigest(
  secret: string,
  domain: string,
  value: unknown,
) {
  if (!/^[a-f0-9]{64}$/iu.test(secret))
    throw new Error("Privacy execution key unavailable");
  const canonical = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`privacy-execution:v1:${domain}:`)
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function executionContractsMatch(
  stored: unknown,
  current: PrivacyExecutionContract,
) {
  const parsed = executionContractSchema.safeParse(stored);
  if (!parsed.success) return false;
  // Compare canonical serialized values, never trusting a persisted digest alone.
  const a = Buffer.from(JSON.stringify(parsed.data));
  const b = Buffer.from(JSON.stringify(executionContractSchema.parse(current)));
  return a.length === b.length && timingSafeEqual(a, b);
}

export type PrivacyExecutionManifest = Partial<
  Record<"person" | "file", { count: number; identityHashes: string[] }>
>;
export function createExecutionManifest(input: {
  secret: string;
  workspaceId: string;
  requestId: string;
  scope: { personIds: readonly string[]; fileIds: readonly string[] };
}): PrivacyExecutionManifest {
  const result: PrivacyExecutionManifest = {};
  for (const kind of ["person", "file"] as const) {
    const ids = [
      ...new Set(
        input.scope[kind === "person" ? "personIds" : "fileIds"].map((id) =>
          z.uuid().parse(id).toLowerCase(),
        ),
      ),
    ].sort();
    if (ids.length)
      result[kind] = {
        count: ids.length,
        identityHashes: ids
          .map((id) =>
            privacyExecutionDigest(input.secret, "identity", [
              input.workspaceId,
              input.requestId,
              kind,
              id,
            ]),
          )
          .sort(),
      };
  }
  return result;
}
