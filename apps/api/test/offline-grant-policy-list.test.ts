import { BadRequestException } from "@nestjs/common";
import type { PlatformPrincipal } from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";
import { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";

const offlineGrant = {
  version: 1 as const,
  maxOfflineMs: 28_800_000,
  maxCompletionMs: 86_400_000,
  taskBounds: {},
};
const baseRow = {
  id: "a1111111-1111-4111-8111-111111111111",
  policyKey: "factory-standard",
  version: 1,
  status: "draft" as const,
  payloadHash: "a".repeat(64),
  decisionReference: null,
  approvedAt: null,
  approvedByPlatformUserId: null,
  createdByPlatformUserId: "platform-user",
  createdAt: new Date("2026-09-14T00:00:00.000Z"),
};
const principal = {} as PlatformPrincipal;

function serviceFor(rows: unknown[]) {
  const db = {
    select: () => ({ from: () => ({ orderBy: async () => rows }) }),
  };
  return new PlatformCatalogService(db as never, {} as never);
}

describe("offline grant policy listing", () => {
  it("skips unrelated lifecycle policies and returns a valid offline policy", async () => {
    const service = serviceFor([
      { ...baseRow, id: "b1111111-1111-4111-8111-111111111111", payload: {} },
      { ...baseRow, payload: { offlineGrant } },
    ]);

    await expect(service.listOfflineGrantPolicies(principal)).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: baseRow.id,
          offlineGrant,
          createdAt: "2026-09-14T00:00:00.000Z",
        }),
      ],
    });
  });

  it("surfaces a declared malformed offline policy", async () => {
    const service = serviceFor([
      { ...baseRow, payload: { offlineGrant: { ...offlineGrant, version: 2 } } },
    ]);

    await expect(service.listOfflineGrantPolicies(principal)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
