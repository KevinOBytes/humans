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

export const noopSecurityEventLogger: SecurityEventLogger = {
  log: () => undefined,
};

export const productionSecurityEventLogger: SecurityEventLogger = {
  log(event) {
    if (event.severity === "info") {
      console.info(event);
      return;
    }
    if (event.severity === "error") {
      console.error(event);
      return;
    }
    if (event.severity === "warn") console.warn(event);
  },
};
