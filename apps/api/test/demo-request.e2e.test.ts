import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DemoRequestsController } from "../src/modules/demo-requests/demo-requests.controller";
import { DemoRequestService } from "../src/modules/demo-requests/demo-request.service";
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
  let limiterFailure: boolean;
  let captchaFailure: "invalid" | "unavailable" | undefined;
  let repositoryFailure: boolean;
  const acceptedInputs: unknown[] = [];

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
      providers: [{ provide: DemoRequestService, useValue: service }],
    }).compile();
    app = ref.createNestApplication();
    await app.init();
    await listenOnLoopback(app);

    const disabledService = new DemoRequestService(
      { enabled: false, consentVersion: undefined },
      { assertAllowed: () => undefined },
      { assertHuman: async () => undefined },
      { accept: async () => undefined },
    );
    const disabledRef = await Test.createTestingModule({
      controllers: [DemoRequestsController],
      providers: [{ provide: DemoRequestService, useValue: disabledService }],
    }).compile();
    disabledApp = disabledRef.createNestApplication();
    await disabledApp.init();
    await listenOnLoopback(disabledApp);
  });

  afterAll(async () => {
    await Promise.all([app.close(), disabledApp.close()]);
  });

  it("is unauthenticated, normalizes the strict payload, and returns only the durable acknowledgement", async () => {
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
  });

  it("registers no alternate method, child path, or public /api-prefixed route", async () => {
    await request(app.getHttpServer()).get("/demo-requests").expect(404);
    await request(app.getHttpServer()).head("/demo-requests").expect(404);
    await request(app.getHttpServer()).put("/demo-requests").send(body()).expect(404);
    await request(app.getHttpServer()).post("/demo-requests/extra").send(body()).expect(404);
    await request(app.getHttpServer()).post("/api/demo-requests").send(body()).expect(404);
  });

  it("returns only stable public 400, 429, and 503 codes", async () => {
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
  });

  it("returns a bounded 404 while submissions are disabled", async () => {
    await request(disabledApp.getHttpServer())
      .post("/demo-requests")
      .send(body())
      .expect(404, { code: "submission_disabled" });
  });
});
