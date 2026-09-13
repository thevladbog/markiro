import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("durable negotiated evidence", () => {
  it("exports pending receipts, unique effects and stable consumption", () => {
    expect(schema).toHaveProperty("deviceGrantIngestReceipts");
    expect(schema).toHaveProperty("deviceGrantEffects");
    expect(schema).toHaveProperty("deviceGrantConsumption");
  });
});
