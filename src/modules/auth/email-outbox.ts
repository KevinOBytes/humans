import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { authEmailOutbox } from "@/db/schema/auth-email-outbox";
import { invitations } from "@/db/schema/auth";
import { workspaces } from "@/db/schema/workspaces";
import type { EmailMessage, EmailSender } from "@/lib/email/resend";
import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import type { Database } from "@/modules/auth/bootstrap-admin";

const PURPOSE_BY_KIND = {
  verification: "auth-email-verification",
  workspace_invitation: "auth-email-workspace-invitation",
} as const;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 5_000;
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEAD_LETTER_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_CLEANUP_BATCH = 100;

export type AuthEmailOutboxSummary = {
  claimed: number;
  completed: number;
  deadLettered: number;
  deferred: number;
};

type VerificationPayload = {
  html?: string;
  subject: string;
  text?: string;
  to: string;
};

export type AuthEmailKind = keyof typeof PURPOSE_BY_KIND;

type OutboxRow = typeof authEmailOutbox.$inferSelect;

function canonicalPayload(payload: VerificationPayload): string {
  return JSON.stringify({
    ...(payload.html ? { html: payload.html } : {}),
    subject: payload.subject,
    ...(payload.text ? { text: payload.text } : {}),
    to: payload.to,
  });
}

function parsePayload(value: unknown): VerificationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unable to open protected data");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["html", "subject", "text", "to"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    typeof record.subject !== "string" ||
    record.subject.length < 1 ||
    record.subject.length > 200 ||
    typeof record.to !== "string" ||
    record.to.length < 3 ||
    record.to.length > 320 ||
    (record.html !== undefined && typeof record.html !== "string") ||
    (record.text !== undefined && typeof record.text !== "string") ||
    (!record.html && !record.text)
  ) {
    throw new Error("Unable to open protected data");
  }
  return {
    ...(typeof record.html === "string" ? { html: record.html } : {}),
    subject: record.subject,
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    to: record.to.trim().toLowerCase(),
  };
}

function payloadHash(plaintext: string): string {
  return `sha256:${createHash("sha256").update(plaintext, "utf8").digest("hex")}`;
}

function equalHash(left: string, right: string): boolean {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(left) ||
    !/^sha256:[0-9a-f]{64}$/u.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function encodePayload(
  payload: VerificationPayload,
  encryptionKey: string,
  kind: AuthEmailKind,
) {
  const plaintext = canonicalPayload(payload);
  return {
    encryptedPayload: sealEnvelope({
      key: encryptionKey,
      plaintext,
      purpose: PURPOSE_BY_KIND[kind],
    }),
    payloadHash: payloadHash(plaintext),
  };
}

function decodePayload(row: OutboxRow, encryptionKey: string) {
  if (!Object.hasOwn(PURPOSE_BY_KIND, row.kind)) {
    throw new Error("Unable to open protected data");
  }
  const plaintext = openSealedEnvelope({
    key: encryptionKey,
    purpose: PURPOSE_BY_KIND[row.kind as AuthEmailKind],
    token: row.encryptedPayload,
  });
  if (!equalHash(payloadHash(plaintext), row.payloadHash)) {
    throw new Error("Unable to open protected data");
  }
  return parsePayload(JSON.parse(plaintext) as unknown);
}

function idempotencyKey(
  message: VerificationPayload,
  authSecret: string,
  kind: AuthEmailKind,
  material = canonicalPayload(message),
) {
  return `auth-${kind}-${createHmac("sha256", authSecret)
    .update(material, "utf8")
    .digest("hex")}`;
}

export async function enqueueAuthEmail(input: {
  authSecret: string;
  database: Database;
  encryptionKey: string;
  idempotencyMaterial: string;
  kind: AuthEmailKind;
  message: EmailMessage;
  invitationId?: string;
}): Promise<string> {
  if (typeof input.message.to !== "string") {
    throw new TypeError("Authentication email requires one recipient");
  }
  const payload = parsePayload(input.message);
  const encoded = encodePayload(payload, input.encryptionKey, input.kind);
  const key = idempotencyKey(
    payload,
    input.authSecret,
    input.kind,
    input.idempotencyMaterial,
  );
  const id = newId();
  const [created] = await input.database
    .insert(authEmailOutbox)
    .values({
      id,
      kind: input.kind,
      invitationId: input.invitationId,
      encryptedPayload: encoded.encryptedPayload,
      payloadHash: encoded.payloadHash,
      idempotencyKey: key,
    })
    .onConflictDoNothing({ target: authEmailOutbox.idempotencyKey })
    .returning({ id: authEmailOutbox.id });
  return created?.id ?? existingId(input.database, key, encoded.payloadHash);
}

async function deliverWithTimeout(input: {
  deliveryTimeoutMs: number;
  emailSender: EmailSender;
  idempotencyKey: string;
  payload: VerificationPayload;
}): Promise<{ id: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.deliveryTimeoutMs);
  try {
    return await input.emailSender.send(input.payload, {
      idempotencyKey: input.idempotencyKey,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createAuthEmailOutboxSender(input: {
  authSecret: string;
  database: Database;
  encryptionKey: string;
}) {
  const queuedIds: string[] = [];
  const sender: EmailSender = {
    async send(message: EmailMessage): Promise<{ id: string }> {
      if (typeof message.to !== "string") {
        throw new TypeError("Verification email requires one recipient");
      }
      const payload = parsePayload(message);
      const encoded = encodePayload(
        payload,
        input.encryptionKey,
        "verification",
      );
      const key = idempotencyKey(payload, input.authSecret, "verification");
      const id = newId();
      const [created] = await input.database
        .insert(authEmailOutbox)
        .values({
          id,
          kind: "verification",
          encryptedPayload: encoded.encryptedPayload,
          payloadHash: encoded.payloadHash,
          idempotencyKey: key,
        })
        .onConflictDoNothing({ target: authEmailOutbox.idempotencyKey })
        .returning({ id: authEmailOutbox.id });
      const outboxId =
        created?.id ??
        (await existingId(input.database, key, encoded.payloadHash));
      queuedIds.push(outboxId);
      return { id: outboxId };
    },
  };
  return { sender, queuedIds };
}

async function existingId(
  database: Database,
  key: string,
  expectedHash: string,
): Promise<string> {
  const [existing] = await database
    .select({
      id: authEmailOutbox.id,
      payloadHash: authEmailOutbox.payloadHash,
    })
    .from(authEmailOutbox)
    .where(eq(authEmailOutbox.idempotencyKey, key))
    .limit(1);
  if (!existing || !equalHash(existing.payloadHash, expectedHash)) {
    throw new Error("Authentication email idempotency conflict");
  }
  return existing.id;
}

export async function runAuthEmailOutboxOnce(input: {
  database: Database;
  deliveryTimeoutMs?: number;
  emailSender: EmailSender;
  encryptionKey: string;
  ids?: readonly string[];
  limit?: number;
  now?: () => Date;
  workerId?: string;
}): Promise<AuthEmailOutboxSummary> {
  const now = input.now ?? (() => new Date());
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new TypeError("Invalid authentication email batch size");
  }
  if (input.ids && input.ids.length === 0) {
    return { claimed: 0, completed: 0, deadLettered: 0, deferred: 0 };
  }
  const deliveryTimeoutMs = input.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(deliveryTimeoutMs) ||
    deliveryTimeoutMs < 1 ||
    deliveryTimeoutMs > DELIVERY_TIMEOUT_MS
  ) {
    throw new TypeError("Invalid authentication email delivery timeout");
  }
  const workerId = input.workerId ?? randomUUID();
  const rows = await input.database.transaction(async (transaction) => {
    const due = or(
      and(
        eq(authEmailOutbox.state, "queued"),
        lte(authEmailOutbox.scheduledAt, sql`clock_timestamp()`),
      ),
      and(
        eq(authEmailOutbox.state, "running"),
        lt(authEmailOutbox.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    );
    const preview = await transaction
      .select({
        id: authEmailOutbox.id,
        invitationId: authEmailOutbox.invitationId,
      })
      .from(authEmailOutbox)
      .leftJoin(invitations, eq(invitations.id, authEmailOutbox.invitationId))
      .leftJoin(
        workspaces,
        eq(workspaces.organizationId, invitations.organizationId),
      )
      .where(
        and(
          input.ids?.length
            ? inArray(authEmailOutbox.id, input.ids)
            : undefined,
          due,
          or(
            eq(authEmailOutbox.kind, "verification"),
            and(
              eq(authEmailOutbox.kind, "workspace_invitation"),
              eq(invitations.status, "pending"),
              lt(sql`clock_timestamp()`, invitations.expiresAt),
              eq(workspaces.state, "active"),
              isNull(workspaces.deletedAt),
            ),
          ),
        ),
      )
      .orderBy(asc(authEmailOutbox.scheduledAt), asc(authEmailOutbox.id))
      .limit(limit);
    const invitationIds = preview.flatMap((row) =>
      row.invitationId ? [row.invitationId] : [],
    );
    if (invitationIds.length > 0) {
      await transaction
        .select({ id: invitations.id })
        .from(invitations)
        .where(inArray(invitations.id, invitationIds))
        .orderBy(asc(invitations.id))
        .for("share");
    }
    const candidates = preview.length
      ? await transaction
          .select({ id: authEmailOutbox.id })
          .from(authEmailOutbox)
          .leftJoin(
            invitations,
            eq(invitations.id, authEmailOutbox.invitationId),
          )
          .leftJoin(
            workspaces,
            eq(workspaces.organizationId, invitations.organizationId),
          )
          .where(
            and(
              inArray(
                authEmailOutbox.id,
                preview.map((row) => row.id),
              ),
              due,
              or(
                eq(authEmailOutbox.kind, "verification"),
                and(
                  eq(authEmailOutbox.kind, "workspace_invitation"),
                  eq(invitations.status, "pending"),
                  lt(sql`clock_timestamp()`, invitations.expiresAt),
                  eq(workspaces.state, "active"),
                  isNull(workspaces.deletedAt),
                ),
              ),
            ),
          )
          .orderBy(asc(authEmailOutbox.scheduledAt), asc(authEmailOutbox.id))
          .limit(limit)
          .for("update", {
            of: authEmailOutbox,
            skipLocked: true,
          })
      : [];
    if (candidates.length === 0) return [];
    const ids = candidates.map(({ id }) => id);
    return transaction
      .update(authEmailOutbox)
      .set({
        state: "running",
        attemptCount: sql`${authEmailOutbox.attemptCount} + 1`,
        claimGeneration: sql`${authEmailOutbox.claimGeneration} + 1`,
        leaseOwner: workerId,
        leaseExpiresAt: sql<Date>`clock_timestamp() + (${LEASE_MS} * interval '1 millisecond')`,
        updatedAt: now(),
      })
      .where(inArray(authEmailOutbox.id, ids))
      .returning();
  });

  const summary: AuthEmailOutboxSummary = {
    claimed: rows.length,
    completed: 0,
    deadLettered: 0,
    deferred: 0,
  };
  for (const row of rows) {
    try {
      const payload = decodePayload(row, input.encryptionKey);
      const result = await deliverWithTimeout({
        deliveryTimeoutMs,
        emailSender: input.emailSender,
        idempotencyKey: row.idempotencyKey,
        payload,
      });
      const completed = await input.database
        .update(authEmailOutbox)
        .set({
          state: "completed",
          providerMessageId: result.id,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          completedAt: now(),
          updatedAt: now(),
        })
        .where(
          and(
            eq(authEmailOutbox.id, row.id),
            eq(authEmailOutbox.state, "running"),
            eq(authEmailOutbox.leaseOwner, workerId),
            eq(authEmailOutbox.claimGeneration, row.claimGeneration),
          ),
        )
        .returning({ id: authEmailOutbox.id });
      if (completed.length === 1) summary.completed += 1;
      else summary.deferred += 1;
    } catch {
      const deadLetter = row.attemptCount >= MAX_ATTEMPTS;
      const failed = await input.database
        .update(authEmailOutbox)
        .set({
          state: deadLetter ? "dead_letter" : "queued",
          scheduledAt: deadLetter
            ? now()
            : new Date(
                now().getTime() +
                  Math.min(60_000, 1_000 * 2 ** (row.attemptCount - 1)),
              ),
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: "delivery_unavailable",
          updatedAt: now(),
        })
        .where(
          and(
            eq(authEmailOutbox.id, row.id),
            eq(authEmailOutbox.state, "running"),
            eq(authEmailOutbox.leaseOwner, workerId),
            eq(authEmailOutbox.claimGeneration, row.claimGeneration),
          ),
        )
        .returning({ id: authEmailOutbox.id });
      if (failed.length === 1 && deadLetter) summary.deadLettered += 1;
      else if (failed.length === 1) summary.deferred += 1;
    }
  }
  return summary;
}

export async function cleanupAuthEmailOutbox(input: {
  database: Database;
  limit?: number;
  now?: () => Date;
}): Promise<number> {
  const limit = input.limit ?? MAX_CLEANUP_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLEANUP_BATCH) {
    throw new TypeError("Invalid authentication email cleanup batch size");
  }
  const now = input.now?.() ?? new Date();
  const completedBefore = new Date(now.getTime() - COMPLETED_RETENTION_MS);
  const deadLetterBefore = new Date(now.getTime() - DEAD_LETTER_RETENTION_MS);
  return input.database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({ id: authEmailOutbox.id })
      .from(authEmailOutbox)
      .where(
        or(
          and(
            eq(authEmailOutbox.state, "completed"),
            lt(authEmailOutbox.updatedAt, completedBefore),
          ),
          and(
            eq(authEmailOutbox.state, "dead_letter"),
            lt(authEmailOutbox.updatedAt, deadLetterBefore),
          ),
        ),
      )
      .orderBy(asc(authEmailOutbox.updatedAt), asc(authEmailOutbox.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return 0;
    const deleted = await transaction
      .delete(authEmailOutbox)
      .where(
        and(
          inArray(
            authEmailOutbox.id,
            candidates.map(({ id }) => id),
          ),
          or(
            and(
              eq(authEmailOutbox.state, "completed"),
              lt(authEmailOutbox.updatedAt, completedBefore),
            ),
            and(
              eq(authEmailOutbox.state, "dead_letter"),
              lt(authEmailOutbox.updatedAt, deadLetterBefore),
            ),
          ),
        ),
      )
      .returning({ id: authEmailOutbox.id });
    return deleted.length;
  });
}
