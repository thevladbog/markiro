import { readFileSync } from "node:fs";

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { logoToWire } from "../src/labels/logo.js";
import {
  boxReportRowsSchema,
  officeLicenseSchema,
  palletReportRowsSchema,
} from "../src/host/protocol.js";
import { customBrandingAllowed, readFormLogo } from "../src/office/branding.js";
import { prepareForm } from "../src/office/forms/render-form.js";
import { taskFormInputs } from "../src/office/forms/task-inputs.js";
import { disaggregationReportRowsSchema } from "../src/host/disaggregation.js";
import { fakeOfficeSession, ORG_PROFILE } from "./support/office.js";
import { ACTIVE, LINE_2, MILK, NORTH } from "./support/shifts.js";

const testModuleUrl = import.meta.url;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
const LICENSE = officeLicenseSchema.parse(fixture("office-license.json"));
const BOX_ROWS = boxReportRowsSchema.parse(fixture("box-report-rows.json"));
const PALLET_ROWS = palletReportRowsSchema.parse(fixture("pallet-report-rows.json"));
const OWN = { width: 16, height: 1, stride: 2, pixels: new Uint8Array([0xaa, 0x55]) };
const PNG = /^data:image\/png;base64,/;

function setup(options: { customLogo: boolean; logo: boolean }) {
  const fake = fakeOfficeSession();
  fake.api.getLicense.mockResolvedValue({
    ...LICENSE,
    features: { ...LICENSE.features, customLogo: options.customLogo },
  });
  fake.api.getOrgLogo.mockResolvedValue({
    logo: options.logo ? { ...logoToWire(OWN), updatedAt: "2026-10-11T09:00:00Z" } : null,
  });
  return fake;
}

const client = () => new QueryClient();

describe("custom branding is a license feature (customLogo)", () => {
  it("allows the organization's logo only when the license carries the feature", () => {
    expect(customBrandingAllowed(LICENSE)).toBe(true);
    expect(customBrandingAllowed({ features: { ...LICENSE.features, customLogo: false } })).toBe(
      false,
    );
    // Not read: no license to brand with.
    expect(customBrandingAllowed(undefined)).toBe(false);
    expect(customBrandingAllowed(null)).toBe(false);
  });

  it("gives a printed form the organization's logo as a PNG when allowed and uploaded", async () => {
    const fake = setup({ customLogo: true, logo: true });
    const logo = await readFormLogo(client(), fake.api, fake.call);
    expect(logo).toMatch(PNG);
  });

  it("gives none without the feature, without a logo, or when a read fails", async () => {
    for (const options of [
      { customLogo: false, logo: true },
      { customLogo: true, logo: false },
    ]) {
      const fake = setup(options);
      expect(await readFormLogo(client(), fake.api, fake.call)).toBeNull();
    }
    const failing = setup({ customLogo: true, logo: true });
    failing.api.getLicense.mockRejectedValue(new Error("host down"));
    expect(await readFormLogo(client(), failing.api, failing.call)).toBeNull();
    const noLogoRead = setup({ customLogo: true, logo: true });
    noLogoRead.api.getOrgLogo.mockRejectedValue(new Error("host down"));
    expect(await readFormLogo(client(), noLogoRead.api, noLogoRead.call)).toBeNull();
  });

  it("does not read the organization's logo at all without the feature", async () => {
    const fake = setup({ customLogo: false, logo: true });
    await readFormLogo(client(), fake.api, fake.call);
    expect(fake.api.getOrgLogo).not.toHaveBeenCalled();
  });
});

describe("the printed forms carry the logo they are given", () => {
  const logo = "data:image/png;base64,iVBORw0KGgo=";
  const markiro = 'data-brand-logo="markiro"';

  it.each([
    ["box", { kind: "box", rows: BOX_ROWS, timeZone: "UTC" }],
    [
      "pallet",
      {
        kind: "pallet",
        rows: PALLET_ROWS,
        palletId: PALLET_ROWS.pallets[0]?.id ?? "",
        timeZone: "UTC",
      },
    ],
    [
      "placard",
      {
        kind: "placard",
        rows: PALLET_ROWS,
        palletId: PALLET_ROWS.pallets[0]?.id ?? "",
        format: "a4",
      },
    ],
  ] as const)(
    "the %s form: Markiro's without a logo, the organization's with one",
    (_name, request) => {
      const plain = prepareForm(request)?.draw() ?? "";
      const branded = prepareForm({ ...request, logo })?.draw() ?? "";
      expect(plain).toContain(markiro);
      expect(plain).not.toContain("brand-logo--organization");
      expect(branded).toContain("brand-logo--organization");
      expect(branded).toContain(`src="${logo}"`);
      expect(branded).not.toContain(markiro);
    },
  );

  it("the shift's blank and the disaggregation act too", () => {
    const inputs = taskFormInputs(ACTIVE, [MILK], [LINE_2], [NORTH], ORG_PROFILE, null);
    if (inputs === null) throw new Error("no inputs");
    const task = { kind: "task", inputs, generatedAt: new Date("2026-10-15T09:00:00Z") } as const;
    expect(prepareForm(task)?.draw()).toContain(markiro);
    const branded = prepareForm({ ...task, logo })?.draw() ?? "";
    expect(branded).toContain(`src="${logo}"`);
    expect(branded).not.toContain(markiro);
    const rows = disaggregationReportRowsSchema.parse(
      fixture("disaggregation-report-rows-boxes.json"),
    );
    const act = { kind: "act", rows, timeZone: "UTC" } as const;
    expect(prepareForm(act)?.draw()).toContain(markiro);
    expect(prepareForm({ ...act, logo })?.draw()).toContain(`src="${logo}"`);
  });
});
