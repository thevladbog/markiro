import { buildPalletLabelTemplates } from "@markiro/domain";
import { expect, it, vi } from "vitest";

import type { PalletAssemblyPallet } from "../src/floor/pallet-assembly/contracts.js";
import {
  assemblyLabelFields,
  sendAssemblyLabel,
} from "../src/floor/pallet-assembly/assembly-print.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import { fakeRender, ZEBRA } from "./support/printing.js";

const [stock] = buildPalletLabelTemplates();
if (stock === undefined) throw new Error("The pallet label template is missing");

const pallet: PalletAssemblyPallet = {
  id: "00000000-0000-4000-8000-000000000010",
  product: {
    id: "00000000-0000-4000-8000-000000000009",
    name: "Тархун",
    printName: null,
    gtin14: "04600682000013",
    shelfLifeDays: 10,
    capacity: null,
    chzGroupCode: 8,
  },
  boxes: [],
  openedAt: "2026-11-11T09:00:00.000Z",
  closedAt: "2026-11-11T09:12:00.000Z",
  sscc: "146006820000000409",
  label: { template: stock.spec, boxCount: 2, itemCount: 24, productionDate: null },
  labelVersion: 3,
  isCorrection: true,
  printState: "pending",
  printReason: null,
  deferred: false,
  cancelled: false,
  syncState: "pending",
};

it("omits production and expiry dates when the frozen box dates do not agree", () => {
  expect(assemblyLabelFields(pallet)).toMatchObject({
    date: "",
    expiry: "",
    "shift.no": "",
    "qty.boxes": "2",
    qty: "24",
    sscc: "146006820000000409",
  });
});

it("freezes the send before hardware and retains its uncertain result", async () => {
  const order: string[] = [];
  const startPrint = vi.fn(async () => {
    order.push("saved");
    return true;
  });
  const finishPrint = vi.fn(async () => true);
  const runtime = createPrintRuntime(async () => {
    order.push("hardware");
    return { sent: false, code: "outcome_unknown" };
  });

  await sendAssemblyLabel({
    store: { startPrint, finishPrint },
    pallet,
    printer: ZEBRA,
    printing: runtime,
    render: fakeRender,
  });

  expect(order).toEqual(["saved", "hardware"]);
  expect(startPrint).toHaveBeenCalledExactlyOnceWith(pallet.id, 3, undefined);
  expect(finishPrint).toHaveBeenCalledExactlyOnceWith(pallet.id, "unknown", "outcome_unknown");
});

it("does not send a label if the current print state cannot be claimed", async () => {
  const send = vi.fn(async () => ({ sent: true as const }));
  const runtime = createPrintRuntime(send);
  await sendAssemblyLabel({
    store: { startPrint: async () => false, finishPrint: async () => true },
    pallet: { ...pallet, printState: "unknown" },
    printer: ZEBRA,
    printing: runtime,
    render: fakeRender,
  });
  expect(send).not.toHaveBeenCalled();
});

it("does not dispatch a rendered label after the operator loses the screen", async () => {
  const send = vi.fn(async () => ({ sent: true as const }));
  const finishPrint = vi.fn(async () => true);
  let ownsScreen = true;
  await sendAssemblyLabel({
    store: { startPrint: async () => true, finishPrint },
    pallet,
    printer: ZEBRA,
    printing: createPrintRuntime(send),
    render: async (...args) => {
      ownsScreen = false;
      return fakeRender(...args);
    },
    canSend: () => ownsScreen,
  });
  expect(send).not.toHaveBeenCalled();
  expect(finishPrint).toHaveBeenCalledExactlyOnceWith(pallet.id, "failed", "not_sent");
});
