import { describe, expect, it, vi } from "vitest";
import {
  NationalCatalogFreshnessService,
  type NationalCatalogFreshnessRepository,
} from "../src/modules/national-catalog/national-catalog-freshness.service";

describe("confirmed-link freshness scheduling", () => {
  it("schedules bounded confirmed targets with system intent and isolates admission failures", async () => {
    const targets = [
      { tenantId: "a", productId: "a-product" },
      { tenantId: "b", productId: "b-product" },
    ];
    const repository: NationalCatalogFreshnessRepository = {
      listDueProducts: vi.fn(async (limit) => {
        expect(limit).toBe(2);
        return targets;
      }),
      advanceScheduledAt: vi.fn(async () => undefined),
    };
    const calls: string[] = [];
    const scheduler = {
      schedule: async (tenantId: string, productId: string) => {
        calls.push(`${tenantId}/${productId}`);
        if (tenantId === "a") throw new Error("access changed");
      },
    };
    expect(await new NationalCatalogFreshnessService(repository, scheduler, 2).run()).toEqual({
      selected: 2,
      completed: 1,
      failed: 1,
    });
    expect(calls).toEqual(["a/a-product", "b/b-product"]);
    expect(repository.advanceScheduledAt).toHaveBeenCalledTimes(2);
  });
});
