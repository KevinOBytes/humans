// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const httpsRequest = vi.hoisted(() => vi.fn());

vi.mock("node:https", () => ({
  default: { request: httpsRequest },
}));

import { pinnedWebhookTransport } from "@/modules/webhooks/transport";

describe("pinned webhook transport", () => {
  beforeEach(() => {
    httpsRequest.mockReset();
  });

  it("destroys an unfinished response body when delivery is aborted", async () => {
    const response = Object.assign(new PassThrough(), {
      headers: {},
      statusCode: 204,
    });
    const resumeResponse = vi.spyOn(response, "resume");
    const destroyResponse = vi.spyOn(response, "destroy");
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    httpsRequest.mockImplementationOnce(
      (
        _options: Record<string, unknown>,
        onResponse: (value: typeof response) => void,
      ) => {
        request.end.mockImplementation(() => onResponse(response));
        return request;
      },
    );
    const controller = new AbortController();
    const delivery = pinnedWebhookTransport({
      body: '{"event":"webhook.test"}',
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      target: {
        address: "198.51.100.10",
        family: 4,
        hostname: "hooks.example.test",
        url: new URL("https://hooks.example.test/delivery"),
      },
    });

    controller.abort(new Error("delivery timeout"));

    await expect(delivery).rejects.toThrow("delivery timeout");
    expect(resumeResponse).toHaveBeenCalledTimes(1);
    expect(destroyResponse).toHaveBeenCalledTimes(1);
  });
});
