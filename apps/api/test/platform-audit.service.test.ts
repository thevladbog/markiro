import { schema } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

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
});
