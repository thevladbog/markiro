import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityAuditService } from "../src/authorization/security-audit.service";

const FORBIDDEN_FIELD = /"(?:key|secret|token|code|cookie|authorization)"\s*:/i;

describe("SecurityAuditService", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let service: SecurityAuditService;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    service = new SecurityAuditService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only whitelisted authorization-denial fields as JSON", () => {
    const eventWithUnsafeExtras = {
      tenantId: "org_1",
      userId: "user_1",
      action: "ProductsController.listProducts",
      reason: "insufficient_permission",
      required: ["credentials.manage"],
      outcome: "denied",
      key: "mk_plaintext",
      secret: "super-secret",
      authorization: "Bearer session-token",
      url: "/products?api_key=mk_plaintext",
      query: { api_key: "mk_plaintext" },
      headers: { authorization: "Bearer session-token" },
      body: { token: "session-token" },
    } as const;
    service.authorizationDenied(eventWithUnsafeExtras);

    expect(log).toHaveBeenCalledTimes(1);
    const serialized = log.mock.calls[0]![0];
    expect(typeof serialized).toBe("string");
    expect(Object.keys(JSON.parse(serialized as string)).sort()).toEqual([
      "action",
      "outcome",
      "reason",
      "required",
      "tenantId",
      "userId",
    ]);
    expect(serialized).not.toMatch(FORBIDDEN_FIELD);
  });

  it("logs only whitelisted credential-mutation fields as JSON", () => {
    const eventWithUnsafeExtras = {
      tenantId: "org_1",
      userId: "user_1",
      action: "rotate",
      resourceId: "integration_1",
      outcome: "succeeded",
      token: "session-token",
      code: "pair-code",
      cookie: "session-cookie",
      url: "/integrations?token=session-token",
      query: { token: "session-token" },
      headers: { cookie: "session-cookie" },
      body: { secret: "super-secret" },
    } as const;
    service.credentialMutation(eventWithUnsafeExtras);

    expect(log).toHaveBeenCalledTimes(1);
    const serialized = log.mock.calls[0]![0];
    expect(typeof serialized).toBe("string");
    expect(Object.keys(JSON.parse(serialized as string)).sort()).toEqual([
      "action",
      "outcome",
      "resourceId",
      "tenantId",
      "userId",
    ]);
    expect(serialized).not.toMatch(FORBIDDEN_FIELD);
  });

  it("records an unauthenticated device pairing actor without source or secret material", () => {
    const eventWithUnsafeExtras = {
      tenantId: "org_1",
      actorType: "unauthenticated_device",
      actorId: null,
      action: "kiosk.repair",
      resourceId: "kiosk_1",
      outcome: "succeeded",
      source: "192.0.2.10",
      token: "device-token",
      code: "12345678",
      error: new Error("database detail"),
    } as const;
    const deviceCredentialMutation = (
      service as unknown as {
        deviceCredentialMutation(event: typeof eventWithUnsafeExtras): void;
      }
    ).deviceCredentialMutation;

    deviceCredentialMutation.call(service, eventWithUnsafeExtras);

    expect(log).toHaveBeenCalledTimes(1);
    const serialized = log.mock.calls[0]![0];
    expect(typeof serialized).toBe("string");
    expect(Object.keys(JSON.parse(serialized as string)).sort()).toEqual([
      "action",
      "actorId",
      "actorType",
      "outcome",
      "resourceId",
      "tenantId",
    ]);
    expect(serialized).not.toContain("192.0.2.10");
    expect(serialized).not.toContain("database detail");
    expect(serialized).not.toMatch(FORBIDDEN_FIELD);
  });
});
