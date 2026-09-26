import { hasValidCheckDigit } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  defaultWizardValues,
  fieldFromHost,
  stepOf,
  toBootstrapRequest,
  validateStep,
  type WizardValues,
} from "../src/wizard/wizard-form.js";

function values(overrides: Partial<WizardValues> = {}): WizardValues {
  return {
    ...defaultWizardValues("Линия 1"),
    login: "admin",
    adminName: "Ирина Смирнова",
    password: "correct horse battery",
    passwordConfirm: "correct horse battery",
    orgName: "ООО «Атолл»",
    gln: "4600682000013",
    ...overrides,
  };
}

describe("wizard steps", () => {
  it("accept valid answers on every step", () => {
    expect(hasValidCheckDigit("4600682000013")).toBe(true);
    expect(validateStep("review", values())).toEqual([]);
  });

  it("check the administrator", () => {
    expect(validateStep("admin", values({ login: "ад" }))).toEqual([
      { field: "login", message: "rules.login" },
    ]);
    expect(validateStep("admin", values({ adminName: "я".repeat(101) }))).toEqual([
      { field: "adminName", message: "rules.name" },
    ]);
    expect(validateStep("admin", values({ password: "short", passwordConfirm: "short" }))).toEqual([
      { field: "password", message: "rules.password" },
    ]);
    expect(validateStep("admin", values({ passwordConfirm: "another one" }))).toEqual([
      { field: "passwordConfirm", message: "rules.passwordConfirm" },
    ]);
  });

  it("check the organization, including the GLN check digit", () => {
    expect(validateStep("org", values({ gln: "460068200001" }))).toEqual([
      { field: "gln", message: "rules.gln" },
    ]);
    expect(validateStep("org", values({ gln: "4600682000010" }))).toEqual([
      { field: "gln", message: "rules.glnCheckDigit" },
    ]);
    expect(validateStep("org", values({ inn: "77012345678" }))).toEqual([
      { field: "inn", message: "rules.inn" },
    ]);
    expect(validateStep("org", values({ gs1Prefixes: "12, 4600682" }))).toEqual([
      { field: "gs1Prefixes", message: "rules.gs1Prefixes" },
    ]);
    const eleven = Array.from({ length: 11 }, (_, index) => String(4600680 + index)).join(",");
    expect(validateStep("org", values({ gs1Prefixes: eleven }))).toEqual([
      { field: "gs1Prefixes", message: "rules.gs1Prefixes" },
    ]);
    expect(validateStep("org", values({ orgName: "  " }))).toEqual([
      { field: "orgName", message: "rules.orgName" },
    ]);
  });

  it("check the SSCC starts against the prefix capacity", () => {
    expect(validateStep("sscc", values({ boxNextSerial: 0 }))).toEqual([
      { field: "boxNextSerial", message: "wizard.errors.boxSerial" },
    ]);
    expect(validateStep("sscc", values({ palletNextSerial: Number.NaN }))).toEqual([
      { field: "palletNextSerial", message: "wizard.errors.serial" },
    ]);
    expect(validateStep("sscc", values({ boxNextSerial: 10_000_000 }))).toEqual([
      { field: "boxNextSerial", message: "wizard.errors.serialCapacity" },
    ]);
    expect(validateStep("sscc", values({ boxNextSerial: 9_999_999 }))).toEqual([]);
  });

  it("check the lines, repeats ignoring case", () => {
    expect(
      validateStep("lines", values({ lines: [{ name: "Линия 1" }, { name: " линия 1 " }] })),
    ).toEqual([{ field: "lines.1.name", message: "wizard.errors.lineDuplicate" }]);
    expect(validateStep("lines", values({ lines: [{ name: " " }] }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lineName" },
    ]);
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `Линия ${index + 1}` }));
    expect(validateStep("lines", values({ lines: many }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lines" },
    ]);
  });
});

describe("the wizard request", () => {
  it("is trimmed and normalized", () => {
    const request = toBootstrapRequest(
      values({
        login: " admin ",
        orgName: " ООО «Атолл» ",
        inn: " ",
        gs1Prefixes: " 4600682 ;4607091, 4600682 ",
        lines: [{ name: " Линия 1 " }],
      }),
    );
    expect(request).toEqual({
      admin: { login: "admin", name: "Ирина Смирнова", password: "correct horse battery" },
      org: {
        name: "ООО «Атолл»",
        inn: null,
        gln: "4600682000013",
        gs1Prefixes: ["4600682", "4607091"],
        timeZone: "Europe/Moscow",
      },
      sscc: { boxNextSerial: 1, palletNextSerial: 0 },
      lines: ["Линия 1"],
    });
  });

  it("maps host field paths back to wizard fields and steps", () => {
    expect(fieldFromHost("org.gln")).toBe("gln");
    expect(fieldFromHost("admin.password")).toBe("password");
    expect(fieldFromHost("sscc.palletNextSerial")).toBe("palletNextSerial");
    expect(fieldFromHost("lines")).toBe("lines.0.name");
    expect(fieldFromHost("lines.3")).toBe("lines.3.name");
    expect(fieldFromHost("somethingElse")).toBeNull();
    expect(stepOf("gln")).toBe("org");
    expect(stepOf("boxNextSerial")).toBe("sscc");
    expect(stepOf("lines.3.name")).toBe("lines");
    expect(stepOf("passwordConfirm")).toBe("admin");
  });
});
