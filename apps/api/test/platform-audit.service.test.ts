import { schema } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { runWithPlatformRequestContext } from "../src/platform-http/platform-request-context.middleware";

describe("PlatformAuditService", () => {
  it("stores bounded metadata while removing secret-shaped keys recursively", async () => {
    const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = {
      insert: vi.fn((table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          inserted.push({ table, values });
        },
      })),
    };
    const service = new PlatformAuditService();

    await service.record(tx as never, {
      actorPlatformUserId: "platform-user-1",
      actorRole: "platform_admin",
      action: "platform.team.invited",
      outcome: "success",
      tenantId: null,
      targetType: "platform_user",
      targetId: "platform-user-2",
      reason: null,
      before: null,
      after: {
        role: "support",
        activationToken: "must-not-be-stored",
        nested: {
          password: "must-not-be-stored",
          totpSecret: "must-not-be-stored",
          backupCodes: ["must-not-be-stored"],
          status: "invited",
        },
        note: "x".repeat(2_000),
      },
      requestId: "request-1",
    });

    expect(inserted).toEqual([
      {
        table: schema.platformAuditEvents,
        values: {
          actorPlatformUserId: "platform-user-1",
          actorRole: "platform_admin",
          action: "platform.team.invited",
          outcome: "success",
          tenantId: null,
          targetType: "platform_user",
          targetId: "platform-user-2",
          reason: null,
          before: null,
          after: {
            role: "support",
            nested: { status: "invited" },
            note: "x".repeat(1_024),
          },
          requestId: "request-1",
        },
      },
    ]);
    expect(JSON.stringify(inserted.map((write) => write.values))).not.toContain(
      "must-not-be-stored",
    );
  });

  it("keeps CLI calls nullable and lets an explicit event request ID override request context", async () => {
    const requestIds: Array<string | null> = [];
    const tx = {
      insert: vi.fn(() => ({
        values: async (values: { requestId: string | null }) => {
          requestIds.push(values.requestId);
        },
      })),
    };
    const service = new PlatformAuditService();
    const event = {
      actorPlatformUserId: null,
      actorRole: null,
      action: "platform.test",
      outcome: "success",
      tenantId: null,
      targetType: "test",
      targetId: null,
      reason: null,
      before: null,
      after: null,
      requestId: null,
    } as const;

    await service.record(tx as never, event);
    await runWithPlatformRequestContext("11111111-1111-4111-8111-111111111111", async () => {
      await service.record(tx as never, event);
      await service.record(tx as never, {
        ...event,
        requestId: "21111111-1111-4111-8111-111111111111",
      });
    });

    expect(requestIds).toEqual([
      null,
      "11111111-1111-4111-8111-111111111111",
      "21111111-1111-4111-8111-111111111111",
    ]);
  });
});
