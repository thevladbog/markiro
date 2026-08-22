import { getTableConfig } from "drizzle-orm/pg-core";
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

  it("exposes invoice lines and payments as tenant-scoped fulfilment sources", () => {
    expect(Object.keys(schema.invoiceLines)).toEqual(expect.arrayContaining(["tenantId", "id"]));
    expect(Object.keys(schema.billingPayments)).toEqual(
      expect.arrayContaining(["tenantId", "id", "invoiceId"]),
    );
  });

  it("stores versioned legal, postal, and confirmation facts on both profile histories", () => {
    const expectedColumns = [
      "full_name",
      "legal_address_raw",
      "legal_address",
      "postal_same_as_legal",
      "postal_address_raw",
      "postal_address",
      "is_confirmed",
      "confirmed_by_platform_user_id",
      "confirmed_at",
    ];

    for (const table of [schema.operatorBillingProfiles, schema.tenantBillingProfiles]) {
      expect(getTableConfig(table).columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(expectedColumns),
      );
    }
  });
});
