import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("commercial offer print document schema", () => {
  it("exports immutable offer print snapshots and versioned document artifacts", () => {
    expect(schema.commercialOfferPrintSnapshots).toBeDefined();
    expect(schema.commercialOfferDocuments).toBeDefined();
  });

  it("keeps terms and the human-readable number on the commercial offer", () => {
    expect(schema.commercialOffers.termsMarkdown).toBeDefined();
    expect(schema.commercialOffers.number).toBeDefined();
  });
});
