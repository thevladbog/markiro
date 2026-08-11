import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("tenant billing schema", () => {
  it("exports billing profiles, invoices, documents, imports, matches, and application events", () => {
    expect(schema.operatorBillingProfiles).toBeDefined();
    expect(schema.tenantBillingProfiles).toBeDefined();
    expect(schema.invoices).toBeDefined();
    expect(schema.invoiceLines).toBeDefined();
    expect(schema.invoiceDocuments).toBeDefined();
    expect(schema.paymentImports).toBeDefined();
    expect(schema.paymentImportRows).toBeDefined();
    expect(schema.paymentMatches).toBeDefined();
    expect(schema.invoiceApplicationEvents).toBeDefined();
  });

  it("exports the immutable billing enums", () => {
    expect(schema.BILLING_PROFILE_KINDS).toEqual([
      "individual",
      "self_employed",
      "sole_proprietor",
      "legal_entity",
    ]);
    expect(schema.INVOICE_STATUSES).toEqual(["draft", "issued", "paid", "cancelled"]);
    expect(schema.INVOICE_LINE_KINDS).toEqual(["plan", "addon", "service", "custom"]);
    expect(schema.INVOICE_APPLICATION_MODES).toEqual(["manual", "automatic"]);
  });
});
