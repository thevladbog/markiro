import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
import { getTableConfig } from "drizzle-orm/pg-core";

describe("commercial offer print document schema", () => {
  it("defaults legacy artifacts to clean and distinguishes print variants", () => {
    const config = getTableConfig(schema.commercialOfferDocuments);
    const variant = config.columns.find((column) => column.name === "print_variant");
    expect(variant?.default).toBe("clean");
    expect(variant?.notNull).toBe(true);
    expect(
      config.uniqueConstraints.some(
        (constraint) =>
          constraint.columns.map((column) => column.name).join(",") ===
          "offer_id,revision,format,print_variant",
      ),
    ).toBe(true);
  });
  it("exports immutable offer print snapshots and versioned document artifacts", () => {
    expect(schema.commercialOfferPrintSnapshots).toBeDefined();
    expect(schema.commercialOfferDocuments).toBeDefined();
  });

  it("keeps terms and the human-readable number on the commercial offer", () => {
    expect(schema.commercialOffers.termsMarkdown).toBeDefined();
    expect(schema.commercialOffers.number).toBeDefined();
  });
});
