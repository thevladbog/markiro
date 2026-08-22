import { HttpException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PlatformDadataController } from "../src/modules/platform-dadata/platform-dadata.controller";
import { PlatformDadataRateLimit } from "../src/modules/platform-dadata/platform-dadata-rate-limit";
import { PlatformDadataService } from "../src/modules/platform-dadata/platform-dadata.service";
import { PlatformHttpModule } from "../src/platform-http/platform-http.module";
import { listenOnLoopback } from "./support/listen-loopback";

describe("PlatformDadataRateLimit", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [PlatformHttpModule],
      controllers: [PlatformDadataController],
      providers: [
        PlatformDadataRateLimit,
        {
          provide: PlatformDadataService,
          useValue: {
            organizations: async () => ({ status: "no_results", items: [] }),
            addresses: async () => ({ status: "no_results", items: [] }),
            banks: async () => ({ status: "no_results", items: [] }),
            status: () => ({ status: "ready" }),
          },
        },
      ],
    }).compile();
    app = ref.createNestApplication();
    app.use((pending: Request, _response: Response, next: NextFunction) => {
      Object.assign(pending, {
        platformPrincipal: {
          userId: "platform-rate-test",
          role: "accountant",
          capabilities: ["billing.read"],
          twoFactorReady: true,
        },
      });
      next();
    });
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(() => app.close());

  it("allows sixty rolling-minute requests per principal and rejects request 61", () => {
    let now = 1_000;
    const limiter = new PlatformDadataRateLimit(() => now);
    for (let index = 0; index < 60; index += 1) limiter.consume("accountant-a");

    try {
      limiter.consume("accountant-a");
      throw new Error("Expected rate limit rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toEqual({ code: "dadata_rate_limited" });
    }

    expect(() => limiter.consume("accountant-b")).not.toThrow();
    now += 60_001;
    expect(() => limiter.consume("accountant-a")).not.toThrow();
  });

  it("returns the safe platform envelope and request ID for request 61", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    for (let index = 0; index < 60; index += 1) {
      await request(app.getHttpServer())
        .get("/platform/suggestions/organizations?q=abc")
        .expect(200);
    }

    const response = await request(app.getHttpServer())
      .get("/platform/suggestions/organizations?q=abc")
      .set("x-request-id", requestId)
      .expect(429);

    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.body).toEqual({
      code: "dadata_rate_limited",
      message: "Too many platform requests.",
      requestId,
    });
  });
});
