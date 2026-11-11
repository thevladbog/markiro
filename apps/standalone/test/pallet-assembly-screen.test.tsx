import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { buildPalletLabelTemplates } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";
import { expect, it, vi } from "vitest";

import {
  PalletAssemblyScreen,
  type PalletAssemblyScreenProps,
} from "../src/floor/pallet-assembly/PalletAssemblyScreen.js";
import { applyPalletRegistryPage } from "../src/floor/pallet-assembly/registry.js";
import { reconcilePalletAssemblyCloseIssue } from "../src/floor/pallet-assembly/reconcile.js";
import { sendPalletAssemblyBatch } from "../src/floor/pallet-assembly/sender.js";
import { createPalletAssemblyStore } from "../src/floor/pallet-assembly/store.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import { OPERATOR_ID, PAIRING, seedBlock } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, manualRuntime, setUpPrinting } from "./support/printing.js";
import { BOX_SOURCE, BOX_SSCC, seedWarehouseCopies } from "./support/warehouse.js";
import { fakeSource, SESSION } from "./support/work-screen.js";

const SECOND_SSCC = "046006820000015017";
const NOW = "2026-11-11T09:30:00.000Z";

async function station(capacity: number | null = null, sent = false) {
  const { db, executor: local } = openLocalDb();
  seedWarehouseCopies(db);
  db.prepare(
    "INSERT INTO ref_products (id, gtin14, name, chz_group_code, box_capacity, pallet_box_capacity, archived, status, rev) VALUES (?, ?, ?, 8, 12, ?, 0, 'active', 1)",
  ).run(BOX_SOURCE.product.id, BOX_SOURCE.product.gtin14, BOX_SOURCE.product.name, capacity);
  seedBlock(db, {
    blockId: "10000000-0000-4000-8000-000000000001",
    from: 40,
    to: 59,
    extension: 1,
  });
  await applyPalletRegistryPage(
    local,
    PAIRING,
    {
      until: NOW,
      canOpenPallets: true,
      items: [BOX_SSCC, SECOND_SSCC].map((sscc, index) => ({
        sscc,
        kind: "upsert",
        updatedAt: NOW,
        closedAt: NOW,
        productId: BOX_SOURCE.product.id,
        bottleCount: 12,
        productionDate: "2026-11-10",
        shiftNumber: index === 0 ? "NOV26-417" : "NOV26-418",
      })),
    },
    { full: true, first: true, now: new Date(NOW) },
  );
  await setUpPrinting(local, { assignments: { box: null, pallet: "zebra", duplicate: null } });
  const store = createPalletAssemblyStore({
    local,
    pairing: PAIRING,
    operatorId: OPERATOR_ID,
    now: () => new Date(NOW),
  });
  const hardware = fakeHardware(async () =>
    sent ? { sent: true } : { sent: false, code: "outcome_unknown" },
  );
  const { runtime: printing } = manualRuntime(hardware.hardware);
  const gate = createWorkGate();
  const scanner = fakeSource();
  let time = 0;
  const props: PalletAssemblyScreenProps = {
    local,
    store,
    operator: SESSION,
    pairing: PAIRING,
    source: scanner.source,
    printing,
    online: false,
    refresh: vi.fn(async () => undefined),
    onRecorded: vi.fn(),
    onLeave: vi.fn(),
    track: gate.track,
    touch: vi.fn(),
    isLeaving: () => false,
    render: fakeRender,
    clock: () => time,
    signal: vi.fn(),
  };
  const show = (overrides?: Partial<PalletAssemblyScreenProps>) =>
    render(
      <ThemeProvider>
        <PalletAssemblyScreen {...props} {...overrides} />
      </ThemeProvider>,
    );
  const scan = (code: string) =>
    act(async () => {
      scanner.emit(code);
      await gate.drain();
    });
  const press = (name: string | RegExp) =>
    act(async () => {
      time += 1000;
      fireEvent.click(screen.getByRole("button", { name }));
      await gate.drain();
    });
  return { store, local, hardware, scanner, show, scan, press };
}

it("pauses scanner writes while a manual form owns focus", async () => {
  const at = await station();
  at.show();
  await screen.findByText("Отсканируйте SSCC закрытого короба");
  await at.press("Ввести SSCC");
  const field = screen.getByRole("textbox", { name: "SSCC короба" });
  expect(document.activeElement).toBe(field);
  await at.scan(SECOND_SSCC);
  expect((await at.store.read()).open).toBeNull();
  fireEvent.change(field, { target: { value: BOX_SSCC } });
  await at.press("Добавить короб");
  expect((await at.store.read()).open?.boxes.map(({ sscc }) => sscc)).toEqual([BOX_SSCC]);
});

it("enters and corrects an SSCC on the touch keypad before adding the box", async () => {
  const at = await station();
  at.show();
  await screen.findByText("Отсканируйте SSCC закрытого короба");
  await at.press("Ввести SSCC");
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "SSCC короба" });
  const keypad = within(screen.getByRole("group", { name: "Цифровая клавиатура" }));
  const tap = (name: string) => fireEvent.click(keypad.getByRole("button", { name }));

  tap("9");
  tap("Очистить");
  for (const digit of BOX_SSCC.slice(0, -1)) tap(digit);
  tap("9");
  tap("Стереть цифру");
  tap(BOX_SSCC.slice(-1));
  tap("9");

  expect(field.value).toBe(BOX_SSCC);
  expect((await at.store.read()).open).toBeNull();
  await at.press("Добавить короб");
  expect((await at.store.read()).open?.boxes.map(({ sscc }) => sscc)).toEqual([BOX_SSCC]);
});

it("does not resend an uncertain label after reopening the print queue", async () => {
  const at = await station(2);
  const view = at.show();
  await screen.findByText("Отсканируйте SSCC закрытого короба");
  await at.scan(BOX_SSCC);
  await at.scan(SECOND_SSCC);
  await screen.findByText("Неизвестно, вышла ли этикетка");
  expect(at.hardware.sends).toHaveLength(1);
  await at.press("Отложить печать");
  view.unmount();
  at.show({ showPrintQueue: true });
  await at.press(
    await screen
      .findByRole("button", { name: /146006820000000409/ })
      .then((button) => button.textContent ?? ""),
  );
  expect(screen.getByText("Неизвестно, вышла ли этикетка")).toBeTruthy();
  expect(at.hardware.sends).toHaveLength(1);
});

it("requires a deliberate resume before an existing pallet receives scans", async () => {
  const at = await station();
  await at.store.add(BOX_SSCC);
  at.show();
  await screen.findByRole("button", { name: "Продолжить сборку" });
  await at.scan(SECOND_SSCC);
  expect((await at.store.read()).open?.boxes).toHaveLength(1);
  await at.press("Продолжить сборку");
  await at.scan(SECOND_SSCC);
  expect((await at.store.read()).open?.boxes.map((box) => box.shiftNumber)).toEqual(
    expect.arrayContaining(["NOV26-417", "NOV26-418"]),
  );
});

it("refuses to close a smaller composition than the operator confirmed", async () => {
  const at = await station(3);
  const added = await at.store.add(BOX_SSCC);
  if (added.kind !== "added") throw new Error(added.kind);
  await at.store.add(SECOND_SSCC);
  at.show();
  await screen.findByRole("button", { name: "Продолжить сборку" });
  await at.press("Продолжить сборку");
  await at.press("Закрыть и печатать");
  expect(screen.getByText("2 из 3")).toBeTruthy();

  await at.store.remove(added.pallet.id, SECOND_SSCC);
  await at.press("Закрыть и печатать");
  expect((await at.store.get(added.pallet.id))?.sscc).toBeNull();
  expect(at.hardware.sends).toHaveLength(0);
  expect(screen.getByRole("alert").textContent).toContain("Состав изменился");
});

it("requires replacement of a corrected label whose old barcode still matches", async () => {
  const at = await station(null, true);
  const [template] = buildPalletLabelTemplates();
  const first = await at.store.add(BOX_SSCC);
  if (first.kind !== "added" || template === undefined) throw new Error("Missing pallet fixture");
  await at.store.add(SECOND_SSCC);
  const close = await at.store.close(first.pallet.id, "460068200", template.spec);
  if (close.kind !== "closed") throw new Error(close.kind);
  const { id, sscc } = close.pallet;
  if (sscc === null) throw new Error("Missing pallet SSCC");
  const now = () => new Date(NOW);
  await sendPalletAssemblyBatch(
    at.local,
    PAIRING,
    async (records) =>
      records.map((_record, index) =>
        index < 3
          ? { id: null, outcome: "accepted" }
          : {
              id: null,
              outcome: "rejected",
              code: "pallet_count_mismatch",
              details: { closeIssueId: "issue" },
            },
      ),
    now,
  );
  await reconcilePalletAssemblyCloseIssue(
    at.local,
    PAIRING,
    {
      id: "issue",
      palletId: id,
      sscc,
      code: "pallet_count_mismatch",
      status: "approved",
      reportedBoxes: 2,
      currentBoxes: 1,
      currentBoxSsccs: [BOX_SSCC],
      approvedBoxes: 1,
      approvedBoxSsccs: [BOX_SSCC],
      createdAt: NOW,
    },
    now,
  );
  await sendPalletAssemblyBatch(
    at.local,
    PAIRING,
    async (records) => records.map(() => ({ id: null, outcome: "accepted" })),
    now,
  );

  at.show({ showPrintQueue: true });
  await screen.findByRole("button", { name: /146006820000000409/ });
  await at.press(/146006820000000409/);
  await at.press("Напечатать этикетку");
  await screen.findByText("Этикетка передана на принтер");
  expect(screen.queryByRole("button", { name: "Проверить сканером" })).toBeNull();
  await at.scan(sscc);
  expect((await at.store.get(id))?.printState).toBe("sent");
  await at.press("Новая этикетка наклеена");
  expect((await at.store.get(id))?.printState).toBe("confirmed");
});
