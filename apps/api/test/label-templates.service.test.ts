import { describe, expect, it, vi } from "vitest";
import { LabelTemplatesService } from "../src/modules/label-templates/label-templates.service";

describe("LabelTemplatesService delete conflicts", () => {
  it("rethrows a 23503 from an unrelated constraint", async () => {
    const databaseError = Object.assign(new Error("unrelated reference"), {
      code: "23503",
      constraint: "unrelated_foreign_key",
    });
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: async () => [{ id: "a0000000-0000-4000-8000-000000000001" }] }),
      })),
      delete: () => ({ where: async () => Promise.reject(databaseError) }),
    };
    const service = new LabelTemplatesService(db as never);

    await expect(
      service.deleteLabelTemplate("tenant-a", "a0000000-0000-4000-8000-000000000001"),
    ).rejects.toBe(databaseError);
  });
});
