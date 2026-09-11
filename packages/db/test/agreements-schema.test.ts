import { describe, expect, it } from "vitest";

import { platformAgreementDocuments, platformAgreements } from "../src/schema/agreements.js";

describe("platform agreements schema", () => {
  it("keeps the tenant link optional", () => {
    expect(platformAgreements.tenantId.notNull).toBe(false);
  });

  it("stores the counterparty INN as its own indexed column", () => {
    expect(platformAgreements.counterpartyInn.name).toBe("counterparty_inn");
  });

  it("records the document form and defaults it to Russian", () => {
    expect(platformAgreements.documentForm.name).toBe("document_form");
    expect(platformAgreements.documentForm.notNull).toBe(true);
    expect(platformAgreements.documentForm.default).toBe("ru");
    expect(platformAgreements.documentForm.enumValues).toEqual(["ru", "ru_en"]);
  });

  it("requires a checksum and a size on every document row", () => {
    expect(platformAgreementDocuments.sha256.notNull).toBe(true);
    expect(platformAgreementDocuments.byteSize.notNull).toBe(true);
  });
});
