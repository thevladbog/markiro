import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  hasValidCheckDigit,
  PALLET_LABEL_TEMPLATE_NAME,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { bootstrapRequestSchema, type TemplatePurpose } from "../src/host/protocol.js";
import {
  defaultWizardValues,
  fieldFromHost,
  MAX_STOCK_TEMPLATES,
  stepOf,
  stockTemplateCounts,
  stockTemplates,
  toBootstrapRequest,
  validateStep,
  type WizardValues,
} from "../src/wizard/wizard-form.js";
import { EXPECTED_TEMPLATES } from "./support/wizard.js";

function values(overrides: Partial<WizardValues> = {}): WizardValues {
  return {
    ...defaultWizardValues("Линия 1"),
    login: "admin",
    adminName: "Ирина Смирнова",
    password: "correct horse battery",
    passwordConfirm: "correct horse battery",
    orgName: "ООО «Атолл»",
    inn: "7707083893",
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
    // A license is issued to the INN (plan ЛЦ-2): the wizard needs one whose check digit holds.
    expect(validateStep("org", values({ inn: "" }))).toEqual([
      { field: "inn", message: "wizard.errors.innRequired" },
    ]);
    expect(validateStep("org", values({ inn: "7707083894" }))).toEqual([
      { field: "inn", message: "wizard.errors.innChecksum" },
    ]);
    expect(validateStep("org", values({ inn: " 7707083893 " }))).toEqual([]);
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
    // A control character inside a name is refused like on the host.
    expect(validateStep("lines", values({ lines: [{ name: "Линия\t1" }] }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lineName" },
    ]);
    // So is an unpaired surrogate, which cannot cross the IPC boundary; a pair is a name.
    expect(validateStep("lines", values({ lines: [{ name: "Линия\ud8001" }] }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lineName" },
    ]);
    expect(validateStep("lines", values({ lines: [{ name: "Линия 😀" }] }))).toEqual([]);
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
        installDemo: false,
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
      templates: EXPECTED_TEMPLATES,
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

describe("the wizard's demo data (spec 2026-10-21)", () => {
  it("is ticked by default and sends the organization's today as the demo shift's date", () => {
    expect(defaultWizardValues("Линия 1").installDemo).toBe(true);
    // 21:30 UTC is already the next day in Moscow.
    const now = new Date("2026-10-20T21:30:00.000Z");
    expect(toBootstrapRequest(values(), now).demoData).toEqual({ productionDate: "2026-10-21" });
    expect(bootstrapRequestSchema.parse(toBootstrapRequest(values(), now)).demoData).toEqual({
      productionDate: "2026-10-21",
    });
  });

  it("leaves the field out when unticked", () => {
    expect("demoData" in toBootstrapRequest(values({ installDemo: false }))).toBe(false);
  });
});

describe("the wizard's stock templates", () => {
  it("go with the request as the strict schema reads it: the domain's box, duplicate and pallet sets, each with its purpose and layout", () => {
    const request = toBootstrapRequest(values());
    expect(bootstrapRequestSchema.parse(request)).toStrictEqual(request);
    expect(request.templates).toStrictEqual(EXPECTED_TEMPLATES);
    expect(stockTemplates()).toStrictEqual(EXPECTED_TEMPLATES);
  });

  it("make exactly the dated box 58×40 and the pallet 100×150 the organization's defaults, leave `orgDefault` out everywhere else, and give a duplicate none", () => {
    const templates = stockTemplates();
    expect(
      templates
        .filter((template) => template.orgDefault === true)
        .map(({ name, purpose }) => ({ name, purpose })),
    ).toStrictEqual([
      { name: DEFAULT_BOX_LABEL_TEMPLATE_NAME, purpose: "box" },
      { name: PALLET_LABEL_TEMPLATE_NAME, purpose: "pallet" },
    ]);
    expect(templates.filter((template) => "orgDefault" in template)).toHaveLength(2);
    expect(templates.some((template) => template.purpose === "product_duplicate")).toBe(true);
  });

  it("count each purpose as the domain builds it and stay within the host's cap of 32", () => {
    const templates = stockTemplates();
    expect(stockTemplateCounts(templates)).toStrictEqual({
      box: buildDefaultLabelTemplates().length,
      pallet: buildPalletLabelTemplates().length,
      duplicate: buildDuplicateLabelTemplates().length,
    });
    expect(MAX_STOCK_TEMPLATES).toBe(32);
    expect(templates.length).toBeLessThanOrEqual(MAX_STOCK_TEMPLATES);
  });

  it("keep the whole request under 256 KiB, an eighth of the host's 2 MiB body limit", () => {
    const body = JSON.stringify(toBootstrapRequest(values()));
    expect(new TextEncoder().encode(body).length).toBeLessThan(256 * 1024);
  });

  it("are counted by purpose", () => {
    const of = (purpose: TemplatePurpose) => ({ purpose });
    expect(
      stockTemplateCounts([
        of("box"),
        of("product_duplicate"),
        of("box"),
        of("pallet"),
        of("box"),
        of("product_duplicate"),
      ]),
    ).toStrictEqual({ box: 3, pallet: 1, duplicate: 2 });
    expect(stockTemplateCounts([])).toStrictEqual({ box: 0, pallet: 0, duplicate: 0 });
  });
});
