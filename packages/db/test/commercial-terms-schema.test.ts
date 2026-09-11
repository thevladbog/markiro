import { getTableColumns } from "drizzle-orm";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";
it("adds nullable metadata without assigning terms to historical data", () => {
  for (const [table, names] of [
    [
      schema.catalogItemVersions,
      ["documentNameRu", "documentNameEn", "subject", "sellerPolicyRevision"],
    ],
    [schema.operatorBillingProfiles, ["taxPolicy"]],
    [schema.commercialOfferLines, ["commercialTerms"]],
    [schema.invoiceLines, ["commercialTerms"]],
    [schema.tenantSubscriptions, ["commercialPeriod"]],
    [schema.subscriptionAddons, ["commercialPeriod"]],
  ] as const) {
    const columns = getTableColumns(table);
    for (const name of names) {
      const column = Object.entries(columns).find(([key]) => key === name)?.[1];
      expect(column, name).toBeDefined();
      expect(column?.notNull).toBe(false);
      expect(column?.hasDefault).toBe(false);
    }
  }
});
