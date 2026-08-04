import "server-only";

import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";

export const INVITATION_HANDOFF_COOKIE = "humans.invitation_handoff";
const PURPOSE = "invitation-handoff";
const LIFETIME_MS = 15 * 60_000;
const INVITATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function sealInvitationHandoff(input: {
  encryptionKey: string;
  invitationId: string;
  now?: Date;
}): string {
  if (!INVITATION_ID.test(input.invitationId)) {
    throw new TypeError("Invalid invitation handoff");
  }
  return sealEnvelope({
    key: input.encryptionKey,
    purpose: PURPOSE,
    plaintext: JSON.stringify({
      expiresAt: (input.now?.getTime() ?? Date.now()) + LIFETIME_MS,
      invitationId: input.invitationId,
    }),
  });
}

export function openInvitationHandoff(input: {
  encryptionKey: string;
  token: string;
  now?: Date;
}): string {
  const parsed = JSON.parse(
    openSealedEnvelope({
      key: input.encryptionKey,
      purpose: PURPOSE,
      token: input.token,
    }),
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid invitation handoff");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.invitationId !== "string" ||
    !INVITATION_ID.test(record.invitationId) ||
    typeof record.expiresAt !== "number" ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.expiresAt <= (input.now?.getTime() ?? Date.now())
  ) {
    throw new Error("Invalid invitation handoff");
  }
  return record.invitationId;
}

export function readCookieValue(headers: Headers, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}
