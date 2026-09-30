import { describe, expect, it } from "vitest";

import { formatSignerName, signaturePlan } from "../src/modules/billing/print-document-layout";
import type { PrintDocumentModel } from "../src/modules/billing/print-document-model";

const model = (kind: PrintDocumentModel["kind"], contact: unknown): PrintDocumentModel => ({
  kind,
  number: "MRK-CO-000001",
  status: "published",
  issuedOrPublishedAt: new Date("2026-09-30T00:00:00.000Z"),
  dueOrExpiresAt: null,
  seller: { legalName: "ИП Богатырев Владислав Сергеевич", taxId: "234106228141", contact },
  buyer: { legalName: "ООО Покупатель" },
  lines: [],
  subtotal: "0.00",
  vatTotal: "0.00",
  total: "0.00",
  termsHtml: null,
});

describe("formatSignerName", () => {
  it.each([
    ["Богатырев Владислав Сергеевич", "В. С. Богатырев"],
    ["  Богатырев   Владислав   Сергеевич  ", "В. С. Богатырев"],
    ["Богатырёв Владислав Сергеевич", "В. С. Богатырёв"],
    ["Иванов Иван", "И. Иванов"],
    ["Иванова Анна-Мария Сергеевна", "А.-М. С. Иванова"],
    ["Иванов-Петров Иван Сергеевич", "И. С. Иванов-Петров"],
    ["Иванов", "Иванов"],
    ["Иванов Иван Иванович оглы", "Иванов Иван Иванович оглы"],
    ["Иванов   Иван   Иванович   оглы", "Иванов Иван Иванович оглы"],
  ])("formats %j as %j", (input, expected) => {
    expect(formatSignerName(input)).toBe(expected);
  });

  it.each([[""], ["   "], [null], [undefined], [42], [{}]])("prints nothing for %j", (input) => {
    expect(formatSignerName(input)).toBeNull();
  });
});

describe("signaturePlan", () => {
  const contact = { name: "Богатырев Владислав Сергеевич", email: null, phone: null };

  it("plans nothing for the clean variant, even when the contact has a name", () => {
    expect(signaturePlan(model("offer", contact), "clean")).toEqual({
      signed: false,
      signerName: null,
      seal: "none",
    });
  });

  it.each(["offer", "invoice"] as const)(
    "signs a %s with the contact name and a seal in the right slot",
    (kind) => {
      expect(signaturePlan(model(kind, contact), "signed")).toEqual({
        signed: true,
        signerName: "В. С. Богатырев",
        seal: "slot",
      });
    },
  );

  it("puts the seal at the edge of the executor column on an act", () => {
    expect(signaturePlan(model("act", contact), "signed")).toEqual({
      signed: true,
      signerName: "В. С. Богатырев",
      seal: "column",
    });
  });

  it.each([
    [{ name: null, email: null, phone: null }],
    [{ name: "  ", email: null, phone: null }],
    [null],
    [undefined],
    ["Богатырев Владислав Сергеевич"],
  ])("leaves the name blank when the frozen contact is %j", (unusable) => {
    expect(signaturePlan(model("offer", unusable), "signed").signerName).toBeNull();
  });
});
