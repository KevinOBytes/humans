export type SecurityEvent =
  | {
      event: "auth.registration.allowed";
      requestId: string;
      severity: "info";
    }
  | {
      event: "auth.registration.denied";
      requestId: string;
      severity: "warn";
    }
  | {
      event: "auth.recovery.requested";
      requestId: string;
      severity: "info";
    }
  | {
      event: "auth.invitation.acceptance_rejected";
      reason:
        | "ALREADY_MEMBER"
        | "EXPIRED"
        | "FORBIDDEN"
        | "INVALID_ROLE"
        | "NOT_FOUND"
        | "UNAVAILABLE";
      requestId: string;
      severity: "warn";
    }
  | {
      event: "auth.infrastructure.failure";
      requestId?: string;
      severity: "error";
    }
  | {
      event: "auth.security.warning";
      severity: "warn";
    }
  | {
      event: "graphql.initialization.internal";
      requestId: string;
      severity: "error";
    }
  | {
      event: "graphql.request.internal";
      requestId: string;
      severity: "error";
    }
  | {
      event: "graphql.operation_limiter.unavailable";
      requestId: string;
      severity: "error";
    };

export type SecurityEventLogger = {
  log(event: SecurityEvent): void;
};

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type InvitationRejectionReason =
  | "ALREADY_MEMBER"
  | "EXPIRED"
  | "FORBIDDEN"
  | "INVALID_ROLE"
  | "NOT_FOUND"
  | "UNAVAILABLE";

const invitationRejectionReasons = new Set<InvitationRejectionReason>([
  "ALREADY_MEMBER",
  "EXPIRED",
  "FORBIDDEN",
  "INVALID_ROLE",
  "NOT_FOUND",
  "UNAVAILABLE",
] as const);

function fallbackSecurityEvent(): SecurityEvent {
  return { event: "auth.infrastructure.failure", severity: "error" };
}

/**
 * Keep the production sink an actual redaction boundary at runtime too.
 * SecurityEvent is a closed TypeScript union, but logger implementations are
 * called from integrations and can receive an object with accidental extra
 * properties (for example a provider error containing a token).  Construct a
 * fresh allowlisted value before handing it to console so those properties
 * cannot become structured log fields.
 */
export function redactSecurityEvent(input: unknown): SecurityEvent {
  try {
    if (input === null || typeof input !== "object") {
      return fallbackSecurityEvent();
    }
    const event = input as Record<string, unknown>;
    const eventName = event.event;
    const safeSeverity =
      event.severity === "info" ||
      event.severity === "warn" ||
      event.severity === "error"
        ? event.severity
        : "error";
    const requestId =
      typeof event.requestId === "string" ? event.requestId : undefined;
    const safeRequestId = requestIdPattern.test(requestId ?? "")
      ? requestId
      : undefined;

    switch (eventName) {
      case "auth.registration.allowed":
      case "auth.registration.denied":
      case "auth.recovery.requested":
      case "auth.infrastructure.failure":
      case "graphql.initialization.internal":
      case "graphql.request.internal":
      case "graphql.operation_limiter.unavailable":
        return {
          event: eventName,
          requestId: safeRequestId ?? "redacted",
          severity: safeSeverity,
        } as SecurityEvent;
      case "auth.invitation.acceptance_rejected": {
        const reason =
          typeof event.reason === "string" &&
          invitationRejectionReasons.has(
            event.reason as InvitationRejectionReason,
          )
            ? (event.reason as InvitationRejectionReason)
            : "UNAVAILABLE";
        return {
          event: eventName,
          reason,
          requestId: safeRequestId ?? "redacted",
          severity: "warn",
        };
      }
      case "auth.security.warning":
        return { event: eventName, severity: "warn" };
      default:
        return fallbackSecurityEvent();
    }
  } catch {
    return fallbackSecurityEvent();
  }
}

export const noopSecurityEventLogger: SecurityEventLogger = {
  log: () => undefined,
};

export const productionSecurityEventLogger: SecurityEventLogger = {
  log(event) {
    const safeEvent = redactSecurityEvent(event);
    if (safeEvent.severity === "info") {
      console.info(safeEvent);
      return;
    }
    if (safeEvent.severity === "error") {
      console.error(safeEvent);
      return;
    }
    if (safeEvent.severity === "warn") console.warn(safeEvent);
  },
};
