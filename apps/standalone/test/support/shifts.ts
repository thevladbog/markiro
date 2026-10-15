import { fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { expect, vi } from "vitest";

import { buildPalletSheetPresets } from "@markiro/domain";

import type {
  CounterpartyRecord,
  LabelTemplateSummary,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OfficeUser,
  PalletSheets,
  ShiftTotals,
  TemplateDefaults,
} from "../../src/host/protocol.js";
import { fakeOfficeSession, ORG_PROFILE, renderOffice, type FakeOfficeSession } from "./office.js";

export const LINE_2: OfficeLine = {
  id: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  name: "Линия 2",
  archived: false,
  rev: 40,
};
export const LINE_10: OfficeLine = {
  id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
  name: "Линия 10",
  archived: false,
  rev: 41,
};
export const OLD_LINE: OfficeLine = {
  id: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
  name: "Линия 1",
  archived: true,
  rev: 30,
};

/** Box templates: for every category, for milk only (group 8), and switched off. */
export const BOX_58: LabelTemplateSummary = {
  id: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  name: "Коробка 58×40",
  purpose: "box",
  enabled: true,
  chzProductGroupCodes: null,
  stock: true,
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  rev: 62,
};
export const MILK_BOX: LabelTemplateSummary = {
  ...BOX_58,
  id: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
  name: "Молоко 100×72",
  chzProductGroupCodes: [8],
  stock: false,
  rev: 63,
};
export const OLD_BOX: LabelTemplateSummary = {
  ...BOX_58,
  id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  name: "Старая коробка",
  enabled: false,
  stock: false,
  rev: 64,
};
export const PALLET: LabelTemplateSummary = {
  ...BOX_58,
  id: "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e",
  name: "Паллета 100×150",
  purpose: "pallet",
  rev: 65,
};

/**
 * Product duplicate templates (plan РЕЖ part B): for every category, for milk
 * only (group 8, at 300 dpi), and switched off.
 */
export const DUPLICATE_58: LabelTemplateSummary = {
  ...BOX_58,
  id: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
  name: "Дубликат 58×40",
  purpose: "product_duplicate",
  rev: 66,
};
export const MILK_DUPLICATE: LabelTemplateSummary = {
  ...DUPLICATE_58,
  id: "c8d9e0f1-a2b3-4c4d-9e5f-6a7b8c9d0e1f",
  name: "Дубликат молока",
  chzProductGroupCodes: [8],
  widthMm: 43,
  heightMm: 25,
  dpi: 300,
  stock: false,
  rev: 67,
};
export const OLD_DUPLICATE: LabelTemplateSummary = {
  ...DUPLICATE_58,
  id: "d9e0f1a2-b3c4-4d5e-8f6a-7b8c9d0e1f2a",
  name: "Старый дубликат",
  enabled: false,
  stock: false,
  rev: 68,
};

export const MILK: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  shelfLifeDays: 10,
  defaultBoxTemplateId: MILK_BOX.id,
  defaultPalletTemplateId: null,
  defaultPalletSheetId: null,
  egaisCode: null,
  defaultCounterpartyId: null,
  photoChecksum: null,
  archived: false,
  status: "active",
  rev: 65,
};
export const WATER: OfficeProduct = {
  ...MILK,
  id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
  gtin14: "04601234000017",
  name: "Вода 0,5 л",
  printName: null,
  chzProductGroupCode: 13,
  boxCapacity: 24,
  defaultBoxTemplateId: null,
  rev: 70,
};
export const KEFIR_DRAFT: OfficeProduct = {
  ...MILK,
  id: "3c4d5e6f-7081-4923-8b4c-5d6e7f809102",
  gtin14: "04602222000026",
  name: "Кефир",
  printName: null,
  palletBoxCapacity: null,
  defaultBoxTemplateId: null,
  status: "draft",
  rev: 71,
};
export const AYRAN_ARCHIVED: OfficeProduct = {
  ...MILK,
  id: "4d5e6f70-8192-4a34-9c5d-6e7f80910213",
  gtin14: "04605555000015",
  name: "Айран",
  printName: null,
  defaultBoxTemplateId: null,
  archived: true,
  rev: 72,
};

export const NORTH: CounterpartyRecord = {
  id: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  name: "ООО «Северный берег»",
  inn: null,
  gln: "4601234000017",
  gs1Prefixes: ["4601234"],
  archived: false,
  rev: 12,
};
export const SOUTH_ARCHIVED: CounterpartyRecord = {
  ...NORTH,
  id: "e3c8d0f2-5a4b-4c7d-9e6f-0a1b2c3d4e5f",
  name: "ООО «Юг»",
  archived: true,
  rev: 13,
};

export const DEFAULTS: TemplateDefaults = {
  defaultBoxTemplateId: BOX_58.id,
  defaultPalletTemplateId: PALLET.id,
  defaultDuplicateTemplateId: null,
  categories: [],
  defaultPalletSheetId: null,
  palletSheetCategories: [],
  rev: 80,
};

/** The figures of a shift no station has worked on: a planned one's. */
export const NO_TOTALS: ShiftTotals = {
  acceptedUnits: 0,
  unitsInClosedBoxes: 0,
  closedBoxes: 0,
  openBoxes: 0,
  lastFactAt: null,
  deviceIds: [],
  closedPallets: 0,
  openPallets: 0,
};

/** An active shift of milk on line 2 for a counterparty, as `office-shift.json`. */
export const ACTIVE: OfficeShift = {
  id: "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  number: "OCT26-004",
  status: "active",
  mode: "aggregation",
  palletsEnabled: false,
  createdFrom: "office",
  productId: MILK.id,
  lineId: LINE_2.id,
  counterpartyId: NORTH.id,
  productionDate: "2026-10-08",
  plannedDate: "2026-10-08",
  plannedQty: 1200,
  boxCapacity: 12,
  boxTemplateId: MILK_BOX.id,
  palletBoxCapacity: null,
  palletTemplateId: null,
  palletSheetTemplateId: null,
  ownerDeviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  openedAt: "2026-10-08T06:02:00Z",
  closedAt: null,
  closeReasonCode: null,
  closeReasonText: null,
  lateDataAt: null,
  createdAt: "2026-10-07T15:30:00Z",
  rev: 71,
  totals: {
    acceptedUnits: 547,
    unitsInClosedBoxes: 540,
    closedBoxes: 45,
    openBoxes: 1,
    lastFactAt: "2026-10-08T09:41:07Z",
    deviceIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
    closedPallets: 0,
    openPallets: 0,
  },
};

/** A planned shift of water on line 10, no plan and no counterparty. */
export const PLANNED: OfficeShift = {
  ...ACTIVE,
  id: "1c9f5e3b-7d2e-4a4f-8b8c-3e6d9f2a5b7c",
  number: "OCT26-005",
  status: "planned",
  productId: WATER.id,
  lineId: LINE_10.id,
  counterpartyId: null,
  productionDate: "2026-10-09",
  // The working day differs from the production date, so a screen that shows the wrong one fails.
  plannedDate: "2026-10-10",
  plannedQty: null,
  boxCapacity: 24,
  boxTemplateId: BOX_58.id,
  ownerDeviceId: null,
  openedAt: null,
  rev: 72,
  totals: NO_TOTALS,
};

/** A shift a station created and closed with a reason, data arriving after. */
export const CLOSED: OfficeShift = {
  ...ACTIVE,
  id: "2d0a6f4c-8e3f-4b5a-9c9d-4f7e0a3b6c8d",
  number: "OCT26-001/S",
  status: "closed",
  createdFrom: "station",
  counterpartyId: null,
  productionDate: "2026-10-01",
  plannedQty: 500,
  closedAt: "2026-10-01T14:00:00Z",
  closeReasonCode: "equipment_stop",
  lateDataAt: "2026-10-01T14:30:00Z",
  rev: 60,
  totals: {
    acceptedUnits: 492,
    unitsInClosedBoxes: 492,
    closedBoxes: 41,
    openBoxes: 0,
    lastFactAt: "2026-10-01T14:30:00Z",
    deviceIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
    closedPallets: 0,
    openPallets: 0,
  },
};

/**
 * The office's session, the administrator's unless `user` says, with every
 * list the shifts page and its dialogs read.
 */
export function shiftsSession(
  shifts: OfficeShift[] = [PLANNED, ACTIVE, CLOSED],
  user?: OfficeUser,
): FakeOfficeSession {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  session.api.listShifts.mockResolvedValue(shifts);
  session.api.listProducts.mockResolvedValue([MILK, WATER, KEFIR_DRAFT, AYRAN_ARCHIVED]);
  session.api.listLines.mockResolvedValue([LINE_10, LINE_2, OLD_LINE]);
  session.api.listCounterparties.mockResolvedValue([NORTH, SOUTH_ARCHIVED]);
  session.api.listTemplates.mockResolvedValue([
    BOX_58,
    MILK_BOX,
    OLD_BOX,
    PALLET,
    DUPLICATE_58,
    MILK_DUPLICATE,
    OLD_DUPLICATE,
  ]);
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  // The shift's card reads the shift it opens: the one the list holds. A test that answers the
  // list with other shifts (`listShifts.mockResolvedValue`) changes what the card reads too.
  let held = shifts;
  const answerList = session.api.listShifts.mockResolvedValue.bind(session.api.listShifts);
  session.api.listShifts.mockResolvedValue = (next) => {
    held = next;
    return answerList(next);
  };
  session.api.getShift.mockImplementation(async (_token, id) => {
    const found = held.find((shift) => shift.id === id);
    if (found === undefined) throw new Error(`no shift ${id}`);
    return found;
  });
  session.api.getTemplateDefaults.mockResolvedValue(DEFAULTS);
  // A shift with pallets reads the A4 sheets; a test about something else finds none.
  session.api.listPalletSheets.mockResolvedValue({ sheets: [], defaultId: null });
  return session;
}

/** Opens «Смены» from the menu and waits for the list. */
export async function openShifts(session: FakeOfficeSession): Promise<RenderResult> {
  // Opened on «Смены» itself: the overview reads the shifts too, which would be one call more.
  const view = renderOffice(session, { initialPath: "/shifts" });
  await screen.findByRole("heading", { name: "Смены" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
  return view;
}

/**
 * Opens a planned shift's card from the list and turns it into its form: «Открыть» on the row,
 * then «Изменить» in the card (owner decision after beta 3.2: no modal for a shift's fields).
 * Resolves with the card's name, which the form keeps as its dialog's.
 */
export async function startEditing(number: string): Promise<string> {
  fireEvent.click(screen.getByRole("button", { name: `Открыть смену ${number}` }));
  const name = `Смена ${number}`;
  const card = await screen.findByRole("dialog", { name });
  fireEvent.click(await within(card).findByRole("button", { name: `Изменить смену ${number}` }));
  await within(screen.getByRole("dialog", { name })).findByRole("button", { name: "Сохранить" });
  return name;
}

/** The rows of the list, without the header. */
export function shiftRows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The row of the shift numbered `number`. */
export function shiftRow(number: string): HTMLElement {
  const row = screen.getByText(number).closest("tr");
  if (!row) throw new Error(`no row for ${number}`);
  return row;
}

/**
 * Picks `day` (as the calendar names it, «8 октября 2026») in the date picker
 * labelled `label`, going back `monthsBack` months from the one it opens on.
 */
export function pickDate(label: string, day: string, monthsBack = 0): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
  const calendar = screen.getByRole("dialog", { name: "Календарь" });
  for (let step = 0; step < monthsBack; step++) {
    fireEvent.click(within(calendar).getByRole("button", { name: "Предыдущий месяц" }));
  }
  fireEvent.click(within(calendar).getByRole("button", { name: day }));
}

/**
 * Waits for the notice that says what was saved and for the focus to be on it: the
 * button that opened the dialog may be gone (a deleted or closed shift's row), and the
 * focus must not be left on the page's body.
 */
export async function expectFocusedNotice(text: string): Promise<void> {
  const notice = (await screen.findByText(text)).closest('[role="alert"]');
  if (notice === null) throw new Error(`"${text}" is not in an alert`);
  await waitFor(() => expect(document.activeElement).toBe(notice));
}

/** «Today» for the date pickers and the production date: the organization's day is 9 October 2026. */
export function freezeToday(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T09:00:00Z"));
}

/** The stock A4 sheets as the host lists them (plan А4): portrait is the main one. */
export function stockSheets(): PalletSheets {
  const presets = buildPalletSheetPresets();
  const sheets = presets.map((preset, index) => ({
    id: `${String(index + 1)}a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a50`,
    name: preset.name,
    enabled: true,
    presetKey: preset.key,
    revision: 1,
    spec: preset.spec,
  }));
  return { sheets, defaultId: sheets[0]?.id ?? null };
}
