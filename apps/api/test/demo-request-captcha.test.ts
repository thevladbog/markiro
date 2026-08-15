import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DemoRequestCaptchaService } from "../src/modules/demo-requests/demo-request-captcha.service";

const CAPTCHA_URL = "https://smartcaptcha.cloud.yandex.ru/validate";
const SERVER_KEY = "ysc2_secret";
const TOKEN = "token";
const SOURCE = "203.0.113.7";

function service(fetcher: typeof fetch): DemoRequestCaptchaService {
  return new DemoRequestCaptchaService({
    serverKey: SERVER_KEY,
    landingOrigin: "https://markiro.app",
    fetcher,
  });
}

function serviceWithEvents(fetcher: typeof fetch, events: unknown[]): DemoRequestCaptchaService {
  return new DemoRequestCaptchaService(
    {
      serverKey: SERVER_KEY,
      landingOrigin: "https://markiro.app",
      fetcher,
    },
    { record: (event) => events.push(event) },
  );
}

async function expectPublicError(
  promise: Promise<void>,
  status: HttpStatus,
  code: "captcha_invalid" | "captcha_unavailable",
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(HttpException);
  const exception = thrown as HttpException;
  expect(exception.getStatus()).toBe(status);
  expect(exception.getResponse()).toEqual({ code });
  for (const value of sensitiveValues) {
    expect(String(exception)).not.toContain(value);
    expect(JSON.stringify(exception.getResponse())).not.toContain(value);
  }
}

describe("DemoRequestCaptchaService", () => {
  it("accepts an ok result only for the exact configured landing host", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", host: "markiro.app" }), { status: 200 }),
      );

    await expect(service(fetcher).assertHuman(TOKEN, SOURCE)).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledWith(CAPTCHA_URL, expect.objectContaining({ method: "POST" }));
    const request = fetcher.mock.calls[0]![1]!;
    expect(new URLSearchParams(String(request.body))).toEqual(
      new URLSearchParams({ secret: SERVER_KEY, token: TOKEN, ip: SOURCE }),
    );
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["failed", "expired"])("rejects a %s token as invalid", async (status) => {
    const upstreamBody = `provider-${status}-detail`;
    const events: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status, message: upstreamBody }), { status: 200 }),
      );

    await expectPublicError(
      serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
      HttpStatus.BAD_REQUEST,
      "captcha_invalid",
      [upstreamBody, TOKEN, SERVER_KEY, SOURCE],
    );
    expect(events).toEqual([
      {
        event: "landing_demo_request_captcha_rejected",
        classification: "invalid",
        reason: "provider_status",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(upstreamBody);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(SERVER_KEY);
    expect(JSON.stringify(events)).not.toContain(SOURCE);
  });

  it("rejects a successful response for a different host", async () => {
    const events: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", host: "www.markiro.app" }), { status: 200 }),
      );

    await expectPublicError(
      serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
      HttpStatus.BAD_REQUEST,
      "captcha_invalid",
      [TOKEN, SERVER_KEY, SOURCE],
    );
    expect(events).toEqual([
      {
        event: "landing_demo_request_captcha_rejected",
        classification: "invalid",
        reason: "host_mismatch",
      },
    ]);
  });

  it("maps a non-200 response to a bounded unavailable error", async () => {
    const upstreamBody = "upstream-secret-diagnostic";
    const events: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(upstreamBody, { status: 502 }));

    await expectPublicError(
      serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
      HttpStatus.SERVICE_UNAVAILABLE,
      "captcha_unavailable",
      [upstreamBody, TOKEN, SERVER_KEY, SOURCE],
    );
    expect(events).toEqual([
      {
        event: "landing_demo_request_captcha_rejected",
        classification: "infrastructure",
        reason: "http_status",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(upstreamBody);
  });

  it("rejects a 201 response even when its payload would otherwise be valid", async () => {
    const events: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", host: "markiro.app" }), { status: 201 }),
      );

    await expectPublicError(
      serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
      HttpStatus.SERVICE_UNAVAILABLE,
      "captcha_unavailable",
      [TOKEN, SERVER_KEY, SOURCE],
    );
    expect(events).toEqual([
      {
        event: "landing_demo_request_captcha_rejected",
        classification: "infrastructure",
        reason: "http_status",
      },
    ]);
  });

  it("maps malformed JSON to a bounded unavailable error", async () => {
    const upstreamBody = "not-json-upstream-body";
    const events: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(upstreamBody, { status: 200 }));

    await expectPublicError(
      serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
      HttpStatus.SERVICE_UNAVAILABLE,
      "captcha_unavailable",
      [upstreamBody, TOKEN, SERVER_KEY, SOURCE],
    );
    expect(events).toEqual([
      {
        event: "landing_demo_request_captcha_rejected",
        classification: "infrastructure",
        reason: "malformed_response",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(upstreamBody);
  });

  it("classifies a structurally malformed JSON response without recording its body", async () => {
    const upstreamBody = "private-upstream-field";
    const events: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ unexpected: upstreamBody }), { status: 200 }),
      );

    await expectPublicError(
      serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
      HttpStatus.SERVICE_UNAVAILABLE,
      "captcha_unavailable",
      [upstreamBody, TOKEN, SERVER_KEY, SOURCE],
    );
    expect(events).toEqual([
      {
        event: "landing_demo_request_captcha_rejected",
        classification: "infrastructure",
        reason: "malformed_response",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(upstreamBody);
  });

  it("fails closed after the 1.5 second upstream timeout", async () => {
    const events: unknown[] = [];
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    try {
      const result = expectPublicError(
        serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
        HttpStatus.SERVICE_UNAVAILABLE,
        "captcha_unavailable",
        [TOKEN, SERVER_KEY, SOURCE],
      );
      timeoutController.abort();
      await result;
      expect(timeoutSpy).toHaveBeenCalledWith(1_500);
      expect(events).toEqual([
        {
          event: "landing_demo_request_captcha_rejected",
          classification: "infrastructure",
          reason: "network",
        },
      ]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("maps a network failure to a bounded unavailable error", async () => {
    const upstreamMessage = "network detail with internal route";
    const events: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(upstreamMessage));

    await expectPublicError(
      serviceWithEvents(fetcher, events).assertHuman(TOKEN, SOURCE),
      HttpStatus.SERVICE_UNAVAILABLE,
      "captcha_unavailable",
      [upstreamMessage, TOKEN, SERVER_KEY, SOURCE],
    );
    expect(events).toEqual([
      {
        event: "landing_demo_request_captcha_rejected",
        classification: "infrastructure",
        reason: "network",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(upstreamMessage);
  });

  it("keeps the public captcha error when the telemetry sink throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "failed", host: "markiro.app" }), { status: 200 }),
      );
    const captcha = new DemoRequestCaptchaService(
      { serverKey: SERVER_KEY, landingOrigin: "https://markiro.app", fetcher },
      {
        record: () => {
          throw new Error("telemetry unavailable");
        },
      },
    );

    await expectPublicError(
      captcha.assertHuman(TOKEN, SOURCE),
      HttpStatus.BAD_REQUEST,
      "captcha_invalid",
      [TOKEN, SERVER_KEY, SOURCE],
    );
  });
});
