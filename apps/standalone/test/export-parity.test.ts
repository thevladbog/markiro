import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatShiftNumber, PALLET_EXPORT_FORMATS, SHIFT_EXPORT_FORMATS } from "@markiro/domain";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import { runExport } from "../src/office/exports/run-export.js";

/**
 * The standalone's half of the export parity with the cloud (plan ЧЗ). The
 * cases of `packages/domain/test/fixtures/shift-export-parity/cases.json`
 * become the rows the host's `GET /v1/office/shifts/{id}/export-source`
 * answers — the host's whole seconds in `closedAt`, the station's instant in
 * `stationClosedAt`, live items only — and every run of the office's port
 * must give exactly `golden.json`, which the cloud's own source and runner
 * wrote (`apps/api/test/standalone-export-parity.test.ts`).
 */

const testModuleUrl = import.meta.url;

function read(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/domain/test/fixtures/shift-export-parity/${name}`, testModuleUrl),
      "utf8",
    ),
  );
}

const instant = z.iso.datetime();
const caseSchema = z.object({
  name: z.string(),
  shift: z.object({
    id: z.string(),
    status: z.enum(["planned", "active", "closed"]),
    productionDate: z.string(),
    monthKey: z.string(),
    seq: z.number().int(),
    createdFrom: z.enum(["office", "station"]),
    closedAt: instant.nullable(),
    closedBy: z.enum(["office", "station"]).nullable(),
    productName: z.string(),
    palletsEnabled: z.boolean(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  codes: z.array(z.object({ codeHash: z.string(), scannedAt: instant, canonical: z.string() })),
  boxes: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
      palletId: z.string().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      boxId: z.string(),
      codeHash: z.string(),
      removed: z.boolean(),
      displaced: z.boolean(),
    }),
  ),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
    }),
  ),
  maxLines: z.array(z.number().int().nullable()),
  palletRuns: z.array(z.string()),
});
type ParityCase = z.infer<typeof caseSchema>;
const parity = z
  .object({ documentId: z.uuid(), fileDateTime: instant, cases: z.array(caseSchema) })
  .parse(read("cases.json"));

const outcomeSchema = z.union([
  z.object({ error: z.string() }).strict(),
  z
    .object({
      openPalletSuppressedBoxCount: z.number().int(),
      parts: z.array(
        z
          .object({
            filename: z.string(),
            codeCount: z.number().int(),
            boxCount: z.number().int(),
            palletCount: z.number().int(),
            physicalLineCount: z.number().int(),
            bytes: z.number().int(),
            sha256: z.string(),
            text: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
type Outcome = z.infer<typeof outcomeSchema>;
const golden = z.record(z.string(), outcomeSchema).parse(read("golden.json"));

/** The host's answer for a case: what `export-source` would send for those facts. */
function hostRows(parityCase: ParityCase): ShiftExportRows {
  const { shift } = parityCase;
  return shiftExportRowsSchema.parse({
    shift: {
      id: shift.id,
      number: formatShiftNumber({
        monthKey: shift.monthKey,
        seq: shift.seq,
        createdFrom: shift.createdFrom === "office" ? "admin" : "station",
      }),
      status: shift.status,
      productionDate: shift.productionDate,
      productName: shift.productName,
      palletsEnabled: shift.palletsEnabled,
      // `format_timestamp`: the host's own instant in whole seconds.
      closedAt: shift.closedAt === null ? null : `${shift.closedAt.slice(0, 19)}Z`,
      stationClosedAt: shift.closedBy === "station" ? shift.closedAt : null,
      lateDataAt: null,
    },
    organization: parityCase.organization,
    codes: parityCase.codes,
    boxes: parityCase.boxes,
    items: parityCase.items
      .filter((item) => !item.removed && !item.displaced)
      .map((item) => ({ boxId: item.boxId, codeHash: item.codeHash })),
    pallets: parityCase.pallets,
  });
}

function runsOf(parityCase: ParityCase) {
  return [
    ...parityCase.maxLines.flatMap((maxLines) =>
      SHIFT_EXPORT_FORMATS.map((format) => ({
        key: `${parityCase.name}/${format.id}@${format.version}/${maxLines ?? "-"}`,
        formatId: format.id as string,
        formatVersion: format.version as number,
        maxLines,
        palletId: null as string | null,
      })),
    ),
    ...parityCase.palletRuns.flatMap((palletId) =>
      PALLET_EXPORT_FORMATS.map((format) => ({
        key: `${parityCase.name}/${format.id}@${format.version}/${palletId}`,
        formatId: format.id as string,
        formatVersion: format.version as number,
        maxLines: null,
        palletId: palletId as string | null,
      })),
    ),
  ];
}

function outcomeOf(parityCase: ParityCase, run: ReturnType<typeof runsOf>[number]): Outcome {
  const result = runExport(hostRows(parityCase), {
    formatId: run.formatId,
    formatVersion: run.formatVersion,
    maxLines: run.maxLines,
    palletId: run.palletId,
    documentId: parity.documentId,
    formedAt: parity.fileDateTime,
  });
  if (!result.ok) return { error: result.failure };
  return {
    openPalletSuppressedBoxCount: result.openPalletSuppressedBoxCount,
    parts: result.parts.map((part) => ({
      filename: part.filename,
      codeCount: part.codeCount,
      boxCount: part.boxCount,
      palletCount: part.palletCount,
      physicalLineCount: part.physicalLineCount,
      bytes: part.bytes.byteLength,
      sha256: createHash("sha256").update(part.bytes).digest("hex"),
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(part.bytes),
    })),
  };
}

describe("the office's exports over the parity cases give the cloud's golden (plan ЧЗ)", () => {
  const runs = parity.cases.flatMap((parityCase) =>
    runsOf(parityCase).map((run) => [run.key, parityCase, run] as const),
  );

  it("runs exactly the golden's exports", () => {
    expect(runs.map(([key]) => key)).toEqual(Object.keys(golden));
  });

  it.each(runs)("%s", (key, parityCase, run) => {
    expect(outcomeOf(parityCase, run)).toEqual(golden[key]);
  });
});
