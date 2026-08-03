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
      reason: "insufficient_permission",
      required: ["credentials.manage"],
      key: "mk_plaintext",
      secret: "super-secret",
      authorization: "Bearer session-token",
    } as const;
    service.authorizationDenied(eventWithUnsafeExtras);

    expect(log).toHaveBeenCalledTimes(1);
    const serialized = log.mock.calls[0]![0];
    expect(typeof serialized).toBe("string");
    expect(Object.keys(JSON.parse(serialized as string)).sort()).toEqual([
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
      token: "session-token",
      code: "pair-code",
      cookie: "session-cookie",
    };
    service.credentialMutation(eventWithUnsafeExtras);

    expect(log).toHaveBeenCalledTimes(1);
    const serialized = log.mock.calls[0]![0];
    expect(typeof serialized).toBe("string");
    expect(Object.keys(JSON.parse(serialized as string)).sort()).toEqual([
      "action",
      "resourceId",
      "tenantId",
      "userId",
    ]);
    expect(serialized).not.toMatch(FORBIDDEN_FIELD);
  });
});
