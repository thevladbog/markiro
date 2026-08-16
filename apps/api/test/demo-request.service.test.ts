import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { DemoRequestDto } from "../src/modules/demo-requests/demo-request.schema";
import { DemoRequestService } from "../src/modules/demo-requests/demo-request.service";
import {
  captchaInvalidError,
  rateLimitedError,
} from "../src/modules/demo-requests/demo-request.errors";

const INPUT: DemoRequestDto = {
  requestId: "11111111-1111-4111-8111-111111111111",
  locale: "en",
  sourcePath: "/en/packing-workstation/",
  consentVersion: "MKR-PD-02/2026.08/01",
  name: "Ada",
  company: "Factory",
  email: "ada@example.test",
  phone: "+12025550114",
  website: "",
  captchaToken: "captcha-token",
};

function expectHttpError(error: unknown, status: HttpStatus, code: string): void {
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(status);
  expect(exception.getResponse()).toEqual({ code });
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("DemoRequestService", () => {
  it("runs limiter, honeypot/consent checks, captcha, and repository in exact order", async () => {
    const calls: string[] = [];
    const service = new DemoRequestService(
      { enabled: true },
      { assertAllowed: () => calls.push("limiter") },
      { assertHuman: async () => void calls.push("captcha") },
      { accept: async () => void calls.push("repository") },
    );

    await expect(service.submit(INPUT, "203.0.113.7")).resolves.toEqual({
      accepted: true,
      requestId: INPUT.requestId,
    });
    expect(calls).toEqual(["limiter", "captcha", "repository"]);
  });

  it("returns bounded 404 before limiter or any later dependency when disabled", async () => {
    const calls: string[] = [];
    const service = new DemoRequestService(
      { enabled: false },
      { assertAllowed: () => calls.push("limiter") },
      { assertHuman: async () => void calls.push("captcha") },
      { accept: async () => void calls.push("repository") },
    );

    expectHttpError(
      await capture(service.submit(INPUT, "203.0.113.7")),
      HttpStatus.NOT_FOUND,
      "submission_disabled",
    );
    expect(calls).toEqual([]);
  });

  it("charges the limiter before rejecting a filled honeypot", async () => {
    const calls: string[] = [];
    const service = new DemoRequestService(
      { enabled: true },
      { assertAllowed: () => calls.push("limiter") },
      { assertHuman: async () => void calls.push("captcha") },
      { accept: async () => void calls.push("repository") },
    );

    expectHttpError(
      await capture(service.submit({ ...INPUT, website: "bot" }, "203.0.113.7")),
      HttpStatus.BAD_REQUEST,
      "invalid_request",
    );
    expect(calls).toEqual(["limiter"]);
  });

  it("rejects a stale consent version after limiter and before captcha", async () => {
    const calls: string[] = [];
    const service = new DemoRequestService(
      { enabled: true },
      { assertAllowed: () => calls.push("limiter") },
      { assertHuman: async () => void calls.push("captcha") },
      { accept: async () => void calls.push("repository") },
    );

    expectHttpError(
      await capture(service.submit({ ...INPUT, consentVersion: "2026-08-14" }, "203.0.113.7")),
      HttpStatus.BAD_REQUEST,
      "invalid_request",
    );
    expect(calls).toEqual(["limiter"]);
  });

  it("stops immediately on limiter or captcha rejection", async () => {
    const limiterCalls: string[] = [];
    const limiterFailure = new DemoRequestService(
      { enabled: true },
      {
        assertAllowed: () => {
          limiterCalls.push("limiter");
          throw rateLimitedError();
        },
      },
      { assertHuman: async () => void limiterCalls.push("captcha") },
      { accept: async () => void limiterCalls.push("repository") },
    );
    expectHttpError(
      await capture(limiterFailure.submit(INPUT, "203.0.113.7")),
      HttpStatus.TOO_MANY_REQUESTS,
      "rate_limited",
    );
    expect(limiterCalls).toEqual(["limiter"]);

    const captchaCalls: string[] = [];
    const captchaFailure = new DemoRequestService(
      { enabled: true },
      { assertAllowed: () => captchaCalls.push("limiter") },
      {
        assertHuman: async () => {
          captchaCalls.push("captcha");
          throw captchaInvalidError();
        },
      },
      { accept: async () => void captchaCalls.push("repository") },
    );
    expectHttpError(
      await capture(captchaFailure.submit(INPUT, "203.0.113.7")),
      HttpStatus.BAD_REQUEST,
      "captcha_invalid",
    );
    expect(captchaCalls).toEqual(["limiter", "captcha"]);
  });

  it("maps repository detail to one bounded unavailable response", async () => {
    const internalDetail = "duplicate constraint email_deliveries_public_request_kind_uq";
    const service = new DemoRequestService(
      { enabled: true },
      { assertAllowed: () => undefined },
      { assertHuman: async () => undefined },
      {
        accept: async () => {
          throw new Error(internalDetail);
        },
      },
    );

    const error = await capture(service.submit(INPUT, "203.0.113.7"));
    expectHttpError(error, HttpStatus.SERVICE_UNAVAILABLE, "submission_unavailable");
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain(internalDetail);
  });
});
