import { readFileSync } from "node:fs";

import { renderDisaggregationReportHtml } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { disaggregationReportRowsSchema } from "../src/host/disaggregation.js";
import { actData } from "../src/office/disaggregation/act-data.js";
import { renderForm } from "../src/office/forms/render-form.js";

const testModuleUrl = import.meta.url;
const rows = (name: string) =>
  disaggregationReportRowsSchema.parse(
    JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8")),
  );
const cloudBytes = (name: string) =>
  readFileSync(
    new URL(`../../../packages/domain/test/fixtures/print-forms/${name}`, testModuleUrl),
    "utf8",
  );

/**
 * The host's rows of the facts of the domain's act snapshots, mapped by the
 * office, draw the cloud's own bytes: the snapshots were written by the
 * cloud's `report.ts` before it moved (plan ДЗГ-О, task 1).
 */
describe("«Акт дезагрегации» from the host's rows", () => {
  it("boxes only: the cloud's bytes", () => {
    expect(
      renderDisaggregationReportHtml(actData(rows("disaggregation-report-rows-boxes.json"))),
    ).toBe(cloudBytes("disaggregation-act-boxes.html"));
  });

  it("boxes and contents: the cloud's bytes", () => {
    expect(
      renderDisaggregationReportHtml(actData(rows("disaggregation-report-rows-full.json"))),
    ).toBe(cloudBytes("disaggregation-act-full.html"));
  });

  it("the office's form: the organization's zone and the manual-upload note", () => {
    const form = renderForm({
      kind: "act",
      rows: rows("disaggregation-report-rows-full.json"),
      timeZone: "Europe/Moscow",
    });
    expect(form?.html).toBe(cloudBytes("disaggregation-act-full-moscow.html"));
    expect(form?.fileName).toBe("Акт дезагрегации DSG-26-0007.html");
  });
});
