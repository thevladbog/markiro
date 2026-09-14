import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";
import { PlatformGrantActivationService } from "../src/modules/device-grants/platform-grant-activation.service";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const principal: PlatformPrincipal = {
  userId: randomUUID(),
  role: "platform_admin",
  capabilities: platformCapabilitiesForRole.platform_admin,
  twoFactorReady: true,
};

describe("offline grant activation request identity errors", () => {
  it.each([
    ["confirm", "offline_grant_activation_confirm_request_uq"],
    ["cancel", "offline_grant_activation_cancel_request_uq"],
  ] as const)(
    "maps only the %s request constraint to a domain conflict",
    async (operation, constraint) => {
      const databaseError = { code: "23505", constraint };
      const { service } = serviceRejecting(databaseError);
      const result =
        operation === "confirm"
          ? service.confirm(randomUUID(), principal, {
              protocol: "offline-grants-activation-v1",
              preparationDigest: "a".repeat(64),
              requestId: randomUUID(),
            })
          : service.cancel(randomUUID(), principal, {
              protocol: "offline-grants-activation-v1",
              reason: "Cancelled by test",
              requestId: randomUUID(),
            });

      await expect(result).rejects.toMatchObject({
        status: 409,
        response: { code: "GRANT_ACTIVATION_REQUEST_CONFLICT" },
      });
    },
  );

  it.each(["confirm", "cancel"] as const)(
    "preserves an unrelated unique violation from %s",
    async (operation) => {
      const databaseError = {
        code: "23505",
        constraint: "offline_grant_device_activations_station_active_uq",
      };
      const { service, rejection } = serviceRejecting(databaseError);
      const result =
        operation === "confirm"
          ? service.confirm(randomUUID(), principal, {
              protocol: "offline-grants-activation-v1",
              preparationDigest: "a".repeat(64),
              requestId: randomUUID(),
            })
          : service.cancel(randomUUID(), principal, {
              protocol: "offline-grants-activation-v1",
              reason: "Cancelled by test",
              requestId: randomUUID(),
            });

      await expect(result).rejects.toBe(rejection);
    },
  );
});

function serviceRejecting(error: unknown): {
  service: PlatformGrantActivationService;
  rejection: { cause: unknown };
} {
  const rejection = { cause: error };
  const db = {
    transaction: vi.fn().mockRejectedValue(rejection),
  } as unknown as Db;
  return {
    rejection,
    service: new PlatformGrantActivationService(db, null, {} as PlatformAuditService, () =>
      Date.parse("2026-09-14T12:00:00.000Z"),
    ),
  };
}
