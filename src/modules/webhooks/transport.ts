import https from "node:https";
import type { IncomingMessage } from "node:http";

import type { PublicWebhookTarget } from "./target";

export type WebhookTransportRequest = Readonly<{
  body: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  target: PublicWebhookTarget;
}>;

export type WebhookTransportResponse = Readonly<{
  status: number;
}>;

export type WebhookTransport = (
  request: WebhookTransportRequest,
) => Promise<WebhookTransportResponse>;

export const pinnedWebhookTransport: WebhookTransport = async (input) =>
  new Promise((resolve, reject) => {
    let response: IncomingMessage | null = null;
    let settled = false;

    const abortReason = () =>
      input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("Webhook delivery aborted");
    if (input.signal.aborted) {
      reject(abortReason());
      return;
    }
    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      request.off("error", onRequestError);
      response?.off("aborted", onResponseAborted);
      response?.off("end", onResponseEnd);
      response?.off("error", onResponseError);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      response?.destroy();
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(abortReason());
    const onRequestError = (error: Error) => fail(error);
    const onResponseAborted = () => fail(new Error("Webhook response aborted"));
    const onResponseError = (error: Error) => fail(error);
    const onResponseEnd = () => {
      if (settled || !response) return;
      settled = true;
      const status = response.statusCode ?? 0;
      cleanup();
      resolve({ status });
    };

    const request = https.request(
      {
        protocol: "https:",
        hostname: input.target.address,
        family: input.target.family,
        port: input.target.url.port || undefined,
        path: `${input.target.url.pathname}${input.target.url.search}`,
        method: "POST",
        headers: {
          ...input.headers,
          host: input.target.url.host,
        },
        signal: input.signal,
        agent: false,
        servername: input.target.hostname,
        rejectUnauthorized: true,
      },
      (incoming) => {
        response = incoming;
        response.once("aborted", onResponseAborted);
        response.once("end", onResponseEnd);
        response.once("error", onResponseError);
        if (input.signal.aborted) {
          onAbort();
          return;
        }
        response.resume();
      },
    );
    request.once("error", onRequestError);
    input.signal.addEventListener("abort", onAbort, { once: true });
    request.end(input.body);
  });
