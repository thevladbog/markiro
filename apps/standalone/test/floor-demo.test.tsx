import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { classifyScan, sampleLabelData, type LabelTemplateSpec } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { demoMarkingCode, isDemoShiftNumber, nextDemoCode } from "../src/floor/demo/demo-codes.js";
import { scannedCode } from "../src/floor/facts.js";
import { LabelPanel } from "../src/floor/print/LabelPanel.js";
import type { PrintJob } from "../src/floor/print/print-jobs.js";
import { readScan } from "../src/floor/work/scan-pipeline.js";
import { openLocalDb } from "./support/local-db.js";
import { PAIRING } from "./support/floor-work.js";

const DEMO_GTIN = "02900000000018";

describe("the demo codes of marking (spec 2026-10-21)", () => {
  it("read as codes of the demo product, with the group separators of a real code", () => {
    const raw = demoMarkingCode(DEMO_GTIN, 1);
    expect(raw).toBe(
      "010290000000001821DEMO000000001\u001d91DEMO\u001d92DEMOSIGNATURE000000001AAAAAAAAAAAAAAAAAAAAAA",
    );
    const scan = classifyScan(raw);
    expect(scan.kind).toBe("km");
    const reading = readScan(raw);
    if (reading.kind !== "km") throw new Error(reading.kind);
    expect(reading.km.gtin14).toBe(DEMO_GTIN);
    expect(reading.km.serial).toBe("DEMO000000001");
    // Distinct codes: each its own hash.
    const hashes = new Set(
      [1, 2, 3].map((n) => {
        const each = readScan(demoMarkingCode(DEMO_GTIN, n));
        if (each.kind !== "km") throw new Error(each.kind);
        return scannedCode(each.km).codeHash;
      }),
    );
    expect(hashes.size).toBe(3);
  });

  it("are offered from the first one this station holds no scan of", async () => {
    const { db, executor } = openLocalDb();
    expect(await nextDemoCode(executor, PAIRING, DEMO_GTIN)).toBe(demoMarkingCode(DEMO_GTIN, 1));
    for (const n of [1, 2]) {
      const reading = readScan(demoMarkingCode(DEMO_GTIN, n));
      if (reading.kind !== "km") throw new Error(reading.kind);
      db.prepare(
        "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, scanned_at) " +
          "VALUES (?, ?, ?, 's', 'b', ?, '2026-10-21T09:00:00.000Z')",
      ).run(PAIRING.hostId, PAIRING.deviceId, scannedCode(reading.km).codeHash, `scan-${n}`);
    }
    expect(await nextDemoCode(executor, PAIRING, DEMO_GTIN)).toBe(demoMarkingCode(DEMO_GTIN, 3));
  });

  it("are a demo shift's by its number", () => {
    expect(isDemoShiftNumber("DEMO-001")).toBe(true);
    expect(isDemoShiftNumber("DEMO-002/S")).toBe(true);
    expect(isDemoShiftNumber("OCT26-001")).toBe(false);
    expect(isDemoShiftNumber(null)).toBe(false);
  });
});

describe("a demo shift's label on the screen (spec 2026-10-21, decision Д2)", () => {
  const AT = "2026-10-21T06:20:00.000Z";
  const job: PrintJob = {
    id: "job-1",
    shiftId: "shift-1",
    purpose: "box",
    subjectId: "box-1",
    sscc: "029000000000000014",
    state: "failed",
    verify: false,
    templateId: "template-1",
    templateRev: 1,
    fields: sampleLabelData(),
    printer: null,
    bytesBase64: null,
    errorCode: "printer_unconfigured",
    attempts: 0,
    operatorId: "operator-1",
    createdAt: AT,
    updatedAt: AT,
  };
  const SPEC: LabelTemplateSpec = {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    elements: [],
  } as unknown as LabelTemplateSpec;
  const settings = async () => ({
    printers: [],
    assignments: { box: null, pallet: null, duplicate: null },
  });

  function panel(demoPreview: LabelTemplateSpec | undefined, onSkip: () => void) {
    render(
      <ThemeProvider>
        <LabelPanel
          job={job}
          busy={false}
          note={null}
          loadSettings={settings}
          onPrintAgain={() => undefined}
          onPrinted={() => undefined}
          onSkip={onSkip}
          {...(demoPreview === undefined ? {} : { demoPreview })}
        />
      </ThemeProvider>,
    );
  }

  it("shows a demo shift's label without a printer and goes on with «Готово»", () => {
    const onSkip = vi.fn();
    panel(SPEC, onSkip);
    expect(screen.getByRole("heading", { name: "Этикетка короба — предпросмотр" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Этикетка 58×40 мм" })).toBeTruthy();
    expect(screen.queryByText("Продолжить без этикетки")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("leaves a real shift's label without a printer as it was: no preview", () => {
    panel(undefined, () => undefined);
    expect(screen.queryByRole("heading", { name: "Этикетка короба — предпросмотр" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Готово" })).toBeNull();
  });
});
