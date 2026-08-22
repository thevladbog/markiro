import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PlatformAuditService } from "../src/platform-auth/platform-audit.service.js";
import { PlatformHttpModule } from "../src/platform-http/platform-http.module.js";
import { listenOnLoopback } from "./support/listen-loopback.js";

const PASSTHROUGH_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const EXPLICIT_AUDIT_REQUEST_ID = "21111111-1111-4111-8111-111111111111";
const auditRequestIds: Array<string | null> = [];

class DatabaseFailure extends Error {}

@Controller("platform/boundary")
class PlatformBoundaryController {
  constructor(private readonly audit: PlatformAuditService) {}

  @Get("success")
  success() {
    return { ok: true };
  }

  @Get("domain")
  domain() {
    throw new BadRequestException({
      code: "tenant_email_conflict",
      message: "password=must-not-leak",
    });
  }

  @Get("validation")
  validation() {
    throw new BadRequestException(["token must be present"]);
  }

  @Get("authorization")
  authorization() {
    throw new UnauthorizedException("cookie must-not-leak");
  }

  @Post("unexpected")
  @HttpCode(500)
  unexpected() {
    throw new DatabaseFailure("password=database-raw-message-must-not-leak");
  }

  @Get("audit")
  async auditFromRequest() {
    await this.recordAudit(null);
    return { ok: true };
  }

  @Get("audit-explicit")
  async auditExplicit() {
    await this.recordAudit(EXPLICIT_AUDIT_REQUEST_ID);
    return { ok: true };
  }

  private async recordAudit(requestId: string | null) {
    await this.audit.record(
      {
        insert: () => ({
          values: async (values: { requestId: string | null }) => {
            auditRequestIds.push(values.requestId);
          },
        }),
      } as never,
      {
        actorPlatformUserId: null,
        actorRole: null,
        action: "platform.boundary.tested",
        outcome: "success",
        tenantId: null,
        targetType: "platform_route",
        targetId: null,
        reason: null,
        before: null,
        after: null,
        requestId,
      },
    );
  }
}

@Controller("ordinary-boundary")
class OrdinaryBoundaryController {
  @Get("error")
  error() {
    throw new BadRequestException("ordinary route error");
  }
}

describe("platform HTTP boundary", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [PlatformHttpModule],
      controllers: [PlatformBoundaryController, OrdinaryBoundaryController],
      providers: [PlatformAuditService],
    }).compile();
    app = ref.createNestApplication();
    const server = app.getHttpAdapter().getInstance() as Express;
    server.get("/api/platform-auth/probe", (_request, response) => {
      response.status(418).json({ code: "better_auth_transport", message: "raw transport" });
    });
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(() => app.close());

  it("passes through only valid UUID request IDs and generates a UUID otherwise", async () => {
    const passedThrough = await request(app.getHttpServer())
      .get("/platform/boundary/success")
      .set("x-request-id", PASSTHROUGH_REQUEST_ID)
      .expect(200);
    expect(passedThrough.headers["x-request-id"]).toBe(PASSTHROUGH_REQUEST_ID);

    for (const supplied of [undefined, "not-a-uuid"]) {
      const pending = request(app.getHttpServer()).get("/platform/boundary/success");
      const response = supplied ? await pending.set("x-request-id", supplied) : await pending;
      expect(response.status).toBe(200);
      expect(response.headers["x-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(response.headers["x-request-id"]).not.toBe(supplied);
    }
  });

  it.each([
    ["domain", 400, "tenant_email_conflict"],
    ["validation", 400, "platform_validation_error"],
    ["authorization", 401, "platform_unauthorized"],
  ])("returns a strict safe error envelope for %s failures", async (path, status, code) => {
    const response = await request(app.getHttpServer())
      .get(`/platform/boundary/${path}`)
      .set("x-request-id", PASSTHROUGH_REQUEST_ID)
      .expect(status);

    expect(response.body).toEqual({
      code,
      message: expect.any(String),
      requestId: PASSTHROUGH_REQUEST_ID,
    });
    expect(response.headers["x-request-id"]).toBe(PASSTHROUGH_REQUEST_ID);
    expect(JSON.stringify(response.body)).not.toMatch(/password|token|cookie|must-not-leak/i);
  });

  it("maps unexpected failures safely and logs no request or exception secrets", async () => {
    const logged: unknown[][] = [];
    const logger = vi.spyOn(Logger.prototype, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const response = await request(app.getHttpServer())
      .post("/platform/boundary/unexpected?token=query-must-not-leak")
      .set("x-request-id", PASSTHROUGH_REQUEST_ID)
      .set("authorization", "Bearer authorization-must-not-leak")
      .set("cookie", "session=cookie-must-not-leak")
      .send({
        password: "body-password-must-not-leak",
        token: "body-token-must-not-leak",
        totp: "123456",
        recoveryCode: "backup-must-not-leak",
      })
      .expect(500);

    logger.mockRestore();
    expect(response.body).toEqual({
      code: "platform_internal_error",
      message: expect.any(String),
      requestId: PASSTHROUGH_REQUEST_ID,
    });
    const serializedLog = JSON.stringify(logged);
    expect(serializedLog).toContain("POST");
    expect(serializedLog).toContain("/platform/boundary/unexpected");
    expect(serializedLog).toContain("DatabaseFailure");
    expect(serializedLog).toContain(PASSTHROUGH_REQUEST_ID);
    expect(serializedLog).not.toMatch(
      /query-must-not-leak|authorization-must-not-leak|cookie-must-not-leak|body-password|body-token|123456|backup-must-not-leak|database-raw-message/i,
    );
  });

  it("preserves Nest default errors outside platform routes", async () => {
    const response = await request(app.getHttpServer()).get("/ordinary-boundary/error").expect(400);
    expect(response.body).toEqual({
      statusCode: 400,
      message: "ordinary route error",
      error: "Bad Request",
    });
    expect(response.headers["x-request-id"]).toBeUndefined();
  });

  it("does not wrap or add headers to the raw Better Auth transport", async () => {
    const response = await request(app.getHttpServer()).get("/api/platform-auth/probe").expect(418);
    expect(response.body).toEqual({ code: "better_auth_transport", message: "raw transport" });
    expect(response.headers["x-request-id"]).toBeUndefined();
  });

  it("inherits the request ID into audit writes while explicit event IDs win", async () => {
    auditRequestIds.length = 0;
    await request(app.getHttpServer())
      .get("/platform/boundary/audit")
      .set("x-request-id", PASSTHROUGH_REQUEST_ID)
      .expect(200);
    await request(app.getHttpServer())
      .get("/platform/boundary/audit-explicit")
      .set("x-request-id", PASSTHROUGH_REQUEST_ID)
      .expect(200);

    expect(auditRequestIds).toEqual([PASSTHROUGH_REQUEST_ID, EXPLICIT_AUDIT_REQUEST_ID]);
  });
});
