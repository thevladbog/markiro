import { describe, expect, it } from "vitest";

import { TARIFF_CODES } from "../content/pricing";
import { isValidInn, LEAD_COPY, validateDownloadLead, validateInvoiceLead } from "./lead-form";

describe("download lead validation", () => {
  it("normalizes the address and keeps the company as typed", () => {
    expect(
      validateDownloadLead({ company: "  ООО «Пивоварня» ", email: " Ivan@Zavod.RU " }),
    ).toEqual({
      ok: true,
      value: { company: "ООО «Пивоварня»", email: "ivan@zavod.ru" },
    });
  });

  it("names the missing domain the way the form-state mockup does", () => {
    expect(validateDownloadLead({ company: "Завод", email: "ivan@zavod" })).toEqual({
      ok: false,
      errors: { email: LEAD_COPY.emailDomain },
    });
  });

  it("asks for both fields when the form is empty", () => {
    expect(validateDownloadLead({ company: " ", email: "" })).toEqual({
      ok: false,
      errors: { company: LEAD_COPY.companyMissing, email: LEAD_COPY.emailMissing },
    });
  });

  it("rejects a company longer than the API accepts", () => {
    const result = validateDownloadLead({ company: "x".repeat(121), email: "a@b.ru" });
    expect(result).toEqual({ ok: false, errors: { company: LEAD_COPY.companyLong } });
  });
});

describe("invoice lead validation", () => {
  it("accepts a company INN, a tariff and an address", () => {
    expect(
      validateInvoiceLead({ email: "buh@zavod.ru", inn: "7707 083 893", tariffCode: "line" }),
    ).toEqual({
      ok: true,
      value: { email: "buh@zavod.ru", inn: "7707083893", tariffCode: "line" },
    });
  });

  it("accepts a sole trader INN of twelve digits", () => {
    expect(isValidInn("500100732259")).toBe(true);
    expect(isValidInn("234106228141")).toBe(true);
  });

  it("explains the INN length before the control digit", () => {
    expect(validateInvoiceLead({ email: "a@b.ru", inn: "77070838", tariffCode: "line" })).toEqual({
      ok: false,
      errors: { inn: LEAD_COPY.innLength },
    });
    expect(validateInvoiceLead({ email: "a@b.ru", inn: "7707083894", tariffCode: "line" })).toEqual(
      {
        ok: false,
        errors: { inn: LEAD_COPY.innChecksum },
      },
    );
  });

  it("accepts only the published tariff codes", () => {
    expect(TARIFF_CODES).toEqual(["start", "line", "workshop", "plant"]);
    expect(validateInvoiceLead({ email: "a@b.ru", inn: "7707083893", tariffCode: "pro" })).toEqual({
      ok: false,
      errors: { tariffCode: LEAD_COPY.tariffMissing },
    });
  });
});
