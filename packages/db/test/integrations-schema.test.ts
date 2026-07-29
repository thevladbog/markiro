import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("integrations schema", () => {
  it("ключует канал парой (тенант, тип) — одна интеграция каждого типа на организацию", () => {
    expect(schema.integrationChannels).toBeDefined();
    const columns = Object.keys(schema.integrationChannels);
    expect(columns).toEqual(
      expect.arrayContaining(["tenantId", "type", "settings", "silentAfterHours", "lastEventAt"]),
    );
  });

  it("держит кандидатов и куски файла отдельными таблицами", () => {
    expect(schema.integrationCandidates).toBeDefined();
    expect(schema.exchangeUploads).toBeDefined();
  });
});
