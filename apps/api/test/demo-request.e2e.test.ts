import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DemoRequestsController } from "../src/modules/demo-requests/demo-requests.controller";
import { DemoRequestService } from "../src/modules/demo-requests/demo-request.service";
import {
  DEMO_REQUEST_SUBMISSION_ENABLED,
  DemoRequestSubmissionGuard,
} from "../src/modules/demo-requests/demo-request-submission.guard";
import { DemoRequestTelemetry } from "../src/modules/demo-requests/demo-request.telemetry";
import {
  captchaInvalidError,
  captchaUnavailableError,
  rateLimitedError,
} from "../src/modules/demo-requests/demo-request.errors";
import { listenOnLoopback } from "./support/listen-loopback";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    locale: "en",
    sourcePath: "/en/packing-workstation/",
    consentVersion: "2026-08-14",
    name: " Ada ",
    company: " Factory ",
    email: " ADA@EXAMPLE.TEST ",
    phone: "+1 (202) 555-0114",
    website: "",
    captchaToken: "captcha-token",
    ...overrides,
  };
}

describe("POST /demo-requests", () => {
  let app: INestApplication;
  let disabledApp: INestApplication;
  let throwingTelemetryApp: INestApplication;
  let limiterFailure: boolean;
  let captchaFailure: "invalid" | "unavailable" | undefined;
  let repositoryFailure: boolean;
  const acceptedInputs: unknown[] = [];
  const disabledSubmit = vi.fn();
  const telemetryEvents: unknown[] = [];

  beforeAll(async () => {
    const service = new DemoRequestService(
      { enabled: true, consentVersion: "2026-08-14" },
      {
        assertAllowed: () => {
          if (limiterFailure) throw rateLimitedError();
        },
      },
      {
        assertHuman: async () => {
          if (captchaFailure === "invalid") throw captchaInvalidError();
          if (captchaFailure === "unavailable") throw captchaUnavailableError();
        },
      },
      {
        accept: async (input) => {
          if (repositoryFailure) throw new Error("private database detail");
          acceptedInputs.push(input);
        },
      },
    );
    const ref = await Test.createTestingModule({
      controllers: [DemoRequestsController],
      providers: [
        { provide: DemoRequestService, useValue: service },
        { provide: DEMO_REQUEST_SUBMISSION_ENABLED, useValue: true },
        {
          provide: DemoRequestTelemetry,
          useValue: { record: (event: unknown) => telemetryEvents.push(event) },
        },
        DemoRequestSubmissionGuard,
      ],
    }).compile();
    app = ref.createNestApplication();
    await app.init();
    await listenOnLoopback(app);

    const disabledRef = await Test.createTestingModule({
      controllers: [DemoRequestsController],
      providers: [
        { provide: DemoRequestService, useValue: { submit: disabledSubmit } },
        { provide: DEMO_REQUEST_SUBMISSION_ENABLED, useValue: false },
        {
          provide: DemoRequestTelemetry,
          useValue: { record: (event: unknown) => telemetryEvents.push(event) },
        },
        DemoRequestSubmissionGuard,
      ],
    }).compile();
    disabledApp = disabledRef.createNestApplication();
    await disabledApp.init();
    await listenOnLoopback(disabledApp);

    const throwingTelemetryRef = await Test.createTestingModule({
      controllers: [DemoRequestsController],
      providers: [
        { provide: DemoRequestService, useValue: service },
        { provide: DEMO_REQUEST_SUBMISSION_ENABLED, useValue: true },
        {
          provide: DemoRequestTelemetry,
          useValue: {
            record: () => {
              throw new Error("telemetry unavailable");
            },
          },
        },
        DemoRequestSubmissionGuard,
      ],
    }).compile();
    throwingTelemetryApp = throwingTelemetryRef.createNestApplication();
    await throwingTelemetryApp.init();
    await listenOnLoopback(throwingTelemetryApp);
  });

  afterAll(async () => {
    await Promise.all([app.close(), disabledApp.close(), throwingTelemetryApp.close()]);
  });

  it("is unauthenticated, normalizes the strict payload, and returns only the durable acknowledgement", async () => {
    const telemetryStart = telemetryEvents.length;
    const response = await request(app.getHttpServer())
      .post("/demo-requests")
      .set("content-type", "application/json")
      .send(body())
      .expect(202);

    expect(response.body).toEqual({ accepted: true, requestId: REQUEST_ID });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(acceptedInputs.at(-1)).toMatchObject({
      name: "Ada",
      company: "Factory",
      email: "ada@example.test",
      phone: "+12025550114",
    });
    expect(telemetryEvents.slice(telemetryStart)).toEqual([
      {
        event: "landing_demo_request_final",
        status: 202,
        code: "accepted",
        locale: "en",
        sourcePath: "/en/packing-workstation/",
      },
    ]);
    const serialized = JSON.stringify(telemetryEvents.slice(telemetryStart));
    for (const forbidden of [
      REQUEST_ID,
      "203.0.113.7",
      "captcha-token",
      "2026-08-14",
      "Ada",
      "Factory",
      "ada@example.test",
      "+12025550114",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("registers no alternate method, child path, or public /api-prefixed route", async () => {
    await request(app.getHttpServer()).get("/demo-requests").expect(404);
    await request(app.getHttpServer()).head("/demo-requests").expect(404);
    await request(app.getHttpServer()).put("/demo-requests").send(body()).expect(404);
    await request(app.getHttpServer()).post("/demo-requests/extra").send(body()).expect(404);
    await request(app.getHttpServer()).post("/api/demo-requests").send(body()).expect(404);
  });

  it("returns only stable public 400, 429, and 503 codes", async () => {
    const telemetryStart = telemetryEvents.length;
    await request(app.getHttpServer())
      .post("/demo-requests")
      .send(body({ unexpected: "field" }))
      .expect(400, { code: "invalid_request" });

    await request(app.getHttpServer())
      .post("/demo-requests")
      .send(body({ website: "bot" }))
      .expect(400, { code: "invalid_request" });

    limiterFailure = true;
    await request(app.getHttpServer())
      .post("/demo-requests")
      .send(body())
      .expect(429, { code: "rate_limited" });
    limiterFailure = false;

    captchaFailure = "invalid";
    await request(app.getHttpServer())
      .post("/demo-requests")
      .send(body())
      .expect(400, { code: "captcha_invalid" });

    captchaFailure = "unavailable";
    await request(app.getHttpServer())
      .post("/demo-requests")
      .send(body())
      .expect(503, { code: "captcha_unavailable" });
    captchaFailure = undefined;

    repositoryFailure = true;
    const response = await request(app.getHttpServer())
      .post("/demo-requests")
      .send(body())
      .expect(503, { code: "submission_unavailable" });
    repositoryFailure = false;
    expect(JSON.stringify(response.body)).not.toContain("database");
    expect(telemetryEvents.slice(telemetryStart)).toEqual([
      {
        event: "landing_demo_request_final",
        status: 400,
        code: "invalid_request",
        locale: "unknown",
        sourcePath: "unknown",
      },
      {
        event: "landing_demo_request_final",
        status: 400,
        code: "invalid_request",
        locale: "en",
        sourcePath: "/en/packing-workstation/",
      },
      {
        event: "landing_demo_request_final",
        status: 429,
        code: "rate_limited",
        locale: "en",
        sourcePath: "/en/packing-workstation/",
      },
      {
        event: "landing_demo_request_final",
        status: 400,
        code: "captcha_invalid",
        locale: "en",
        sourcePath: "/en/packing-workstation/",
      },
      {
        event: "landing_demo_request_final",
        status: 503,
        code: "captcha_unavailable",
        locale: "en",
        sourcePath: "/en/packing-workstation/",
      },
      {
        event: "landing_demo_request_final",
        status: 503,
        code: "submission_unavailable",
        locale: "en",
        sourcePath: "/en/packing-workstation/",
      },
    ]);
    const serialized = JSON.stringify(telemetryEvents.slice(telemetryStart));
    for (const forbidden of [
      REQUEST_ID,
      "203.0.113.7",
      "captcha-token",
      "2026-08-14",
      "Ada",
      "Factory",
      "ada@example.test",
      "+12025550114",
      "bot",
      "private database detail",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns a bounded 404 before body validation while submissions are disabled", async () => {
    const telemetryStart = telemetryEvents.length;
    await request(disabledApp.getHttpServer())
      .post("/demo-requests")
      .send({})
      .expect(404, { code: "submission_disabled" });
    await request(disabledApp.getHttpServer())
      .post("/demo-requests")
      .send({ requestId: "invalid", unexpected: "field" })
      .expect(404, { code: "submission_disabled" });
    await request(disabledApp.getHttpServer())
      .post("/demo-requests")
      .send(body())
      .expect(404, { code: "submission_disabled" });
    expect(disabledSubmit).not.toHaveBeenCalled();
    expect(telemetryEvents.slice(telemetryStart)).toEqual(
      Array.from({ length: 3 }, () => ({
        event: "landing_demo_request_final",
        status: 404,
        code: "submission_disabled",
        locale: "unknown",
        sourcePath: "unknown",
      })),
    );
  });

  it("keeps success and error responses stable when telemetry throws", async () => {
    await request(throwingTelemetryApp.getHttpServer())
      .post("/demo-requests")
      .send(body())
      .expect(202, { accepted: true, requestId: REQUEST_ID });
    await request(throwingTelemetryApp.getHttpServer())
      .post("/demo-requests")
      .send(body({ unexpected: "field" }))
      .expect(400, { code: "invalid_request" });
  });
});
