import { readFileSync } from "node:fs";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  shiftExportRowsSchema,
  type OfficePallet,
  type OfficeShift,
  type ShiftExportRows,
} from "../src/host/protocol.js";
import {
  OfficeFilesError,
  type OfficeFilesApi,
  type OfficeFilesCode,
  type SavedFolder,
} from "../src/office/exports/office-files.js";
import type { ExportWarning } from "../src/office/exports/export-checks.js";
import { runExport, type ExportFailure } from "../src/office/exports/run-export.js";
import {
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { warnedExportRows } from "./support/export-rows.js";
import { ACTIVE, freezeToday, PALLET, shiftsSession } from "./support/shifts.js";

const testModuleUrl = import.meta.url;
const TOKEN = "office-session-token";
const DOCUMENT = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
/** `freezeToday`'s instant: the moment every export of these tests is formed. */
const FORMED_AT = "2026-10-09T09:00:00.000Z";
const PALLET_ID = "a0000000-0000-4000-8000-000000000001";
const HASH_C = "a9d8c7b6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8";

/** `shift-export-rows.json`: OCT26-004 closed, pallet 1 (box 1, two codes) closed, box 2 (one code) on no pallet. */
function rows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

/** The list's record of the same shift, closed and with pallets. */
const CLOSED_PALLETS: OfficeShift = {
  ...ACTIVE,
  status: "closed",
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET.id,
  closedAt: "2026-10-08T14:00:07Z",
};

/** A shell that saves into `C:\Users\Оператор\Documents\Markiro\<segments>` and opens it. */
function fakeFiles(): OfficeFilesApi & {
  save: ReturnType<typeof vi.fn<OfficeFilesApi["save"]>>;
  open: ReturnType<typeof vi.fn<OfficeFilesApi["open"]>>;
  openFile: ReturnType<typeof vi.fn<OfficeFilesApi["openFile"]>>;
} {
  return {
    save: vi.fn<OfficeFilesApi["save"]>(async (segments, files): Promise<SavedFolder> => ({
      segments: [...segments],
      path: `C:\\Users\\Оператор\\Documents\\Markiro\\${segments.join("\\")}`,
      files: files.map((file) => file.name),
    })),
    open: vi.fn<OfficeFilesApi["open"]>(async () => undefined),
    openFile: vi.fn<OfficeFilesApi["openFile"]>(async () => undefined),
  };
}

/** The office on «Смены» with `shift` listed and `source` as its export source, its dialog open. */
async function openDialog(
  shift: OfficeShift,
  source: ShiftExportRows,
  files: OfficeFilesApi,
  user?: typeof TECHNOLOGIST,
  pallets: OfficePallet[] = [],
  prepare: (session: FakeOfficeSession) => void = () => undefined,
): Promise<FakeOfficeSession> {
  const session = shiftsSession([shift], user);
  session.api.getShiftExportSource.mockResolvedValue(source);
  session.api.listShiftPallets.mockResolvedValue(pallets);
  session.api.recordShiftExport.mockResolvedValue(undefined);
  prepare(session);
  renderOffice(session, { files });
  fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
  fireEvent.click(await screen.findByRole("button", { name: `Выгрузка смены ${shift.number}` }));
  await screen.findByRole("dialog", { name: `Выгрузка смены ${shift.number}` });
  return session;
}

/** The same, once the dialog has checked the formats and offers them. */
async function openExport(...args: Parameters<typeof openDialog>): Promise<FakeOfficeSession> {
  const session = await openDialog(...args);
  await screen.findByRole("radiogroup");
  return session;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function form(): void {
  fireEvent.click(within(dialog()).getByRole("button", { name: "Сформировать и сохранить" }));
}

/** What the domain renders for this run: the files the dialog must save, byte for byte. */
function expectedParts(
  source: ShiftExportRows,
  run: {
    formatId: string;
    formatVersion: number;
    maxLines: number | null;
    palletId: string | null;
  },
) {
  const result = runExport(source, { ...run, documentId: DOCUMENT, formedAt: FORMED_AT });
  if (!result.ok) throw new Error(result.failure);
  return result.parts.map((part) => ({ name: part.filename, bytes: part.bytes }));
}

describe("office shifts: an export (plan ЧЗ)", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(DOCUMENT);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forms the chosen format of fresh rows, saves the domain's bytes into the export's own folder, then records it, for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const files = fakeFiles();
      const session = await openExport(CLOSED_PALLETS, rows(), files, user);
      expect(
        within(dialog()).getByText("Молоко 3,2% 0,9 л, дата производства 08.10.2026."),
      ).toBeTruthy();
      expect(
        within(dialog()).getByText(
          "Кодов в смене: 3, из них в закрытых коробах: 3. Закрытых коробов: 2, закрытых паллет: 1.",
        ),
      ).toBeTruthy();
      fireEvent.click(
        within(dialog()).getByRole("radio", { name: "[XML][ГИСМТ] Паллетная агрегация" }),
      );
      form();
      await within(dialog()).findByText(
        "Сохранено файлов: 1. Папка: C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки\\OCT26-004\\2026-10-09_12-00-00_shift_xml_gismt_aggregation_pallets",
      );
      expect(files.save.mock.calls).toEqual([
        [
          ["Выгрузки", "OCT26-004", "2026-10-09_12-00-00_shift_xml_gismt_aggregation_pallets"],
          expectedParts(rows(), {
            formatId: "shift_xml_gismt_aggregation_pallets",
            formatVersion: 1,
            maxLines: null,
            palletId: null,
          }),
        ],
      ]);
      // The rows are read again when the user forms the file, before saving.
      expect(session.api.getShiftExportSource).toHaveBeenCalledTimes(2);
      expect(session.api.getShiftExportSource).toHaveBeenLastCalledWith(TOKEN, ACTIVE.id);
      const [readAgain] = session.api.getShiftExportSource.mock.invocationCallOrder.slice(-1);
      const [saved] = files.save.mock.invocationCallOrder;
      const [recorded] = session.api.recordShiftExport.mock.invocationCallOrder;
      expect(readAgain !== undefined && saved !== undefined && readAgain < saved).toBe(true);
      expect(saved !== undefined && recorded !== undefined && saved < recorded).toBe(true);
      expect(session.api.recordShiftExport.mock.calls).toEqual([
        [
          TOKEN,
          ACTIVE.id,
          {
            formatId: "shift_xml_gismt_aggregation_pallets",
            formatVersion: 1,
            maxLines: null,
            palletId: null,
            documentId: DOCUMENT,
            partCount: 1,
            codeCount: 3,
            boxCount: 2,
            palletCount: 1,
            openPalletSuppressedBoxCount: 0,
          },
        ],
      ]);
      fireEvent.click(within(dialog()).getByRole("button", { name: "Открыть папку" }));
      await waitFor(() =>
        expect(files.open).toHaveBeenCalledWith([
          "Выгрузки",
          "OCT26-004",
          "2026-10-09_12-00-00_shift_xml_gismt_aggregation_pallets",
        ]),
      );
      fireEvent.click(
        within(dialog()).getAllByRole("button", { name: "Закрыть" })[1] as HTMLElement,
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      document.body.innerHTML = "";
    }
  });

  it("offers the reversed boxes format to a shift with pallets and to one without, and saves the cloud's bytes: the codes of a box, then its SSCC (#681)", async () => {
    const withoutPallets = (): ShiftExportRows => {
      const source = rows();
      source.shift.palletsEnabled = false;
      source.boxes = source.boxes.map((box) => ({ ...box, palletId: null }));
      source.pallets = [];
      return source;
    };
    const reversed = "[TXT][С коробами][Обратная] Отчет смены";
    for (const [shift, source, radios] of [
      [CLOSED_PALLETS, rows(), 11],
      [{ ...CLOSED_PALLETS, palletsEnabled: false }, withoutPallets(), 6],
    ] as const) {
      const files = fakeFiles();
      const session = await openExport(shift, source, files);
      expect(within(dialog()).getAllByRole("radio")).toHaveLength(radios);
      const radio = within(dialog()).getByRole("radio", { name: reversed });
      expect(radio.hasAttribute("disabled")).toBe(false);
      fireEvent.click(radio);
      form();
      const folder = "2026-10-09_12-00-00_shift_txt_boxes_reversed";
      await within(dialog()).findByText(
        `Сохранено файлов: 1. Папка: C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки\\OCT26-004\\${folder}`,
      );
      expect(files.save).toHaveBeenCalledTimes(1);
      const [segments, saved] = files.save.mock.calls[0] ?? [];
      expect(segments).toEqual(["Выгрузки", "OCT26-004", folder]);
      expect(saved).toEqual(
        expectedParts(source, {
          formatId: "shift_txt_boxes_reversed",
          formatVersion: 1,
          maxLines: null,
          palletId: null,
        }),
      );
      // The bytes themselves, not only the domain's own answer: each box is its codes, then its
      // 00-prefixed SSCC, then a blank line; the boxes in the order of their SSCCs; UTF-8 text.
      expect(saved?.map((file) => file.name)).toEqual([
        "Молоко_3_2_0_9_л_3pcs_2box_2026-10-08.txt",
      ]);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(saved?.[0]?.bytes)).toBe(
        "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z\n010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y\n" +
          "00046006820000015000\n\n" +
          "010460068200001321Gt5kR1wQe8Uv\u001d93Ef3X\n00046006820000015017\n\n",
      );
      expect(session.api.recordShiftExport.mock.calls).toEqual([
        [
          TOKEN,
          ACTIVE.id,
          {
            formatId: "shift_txt_boxes_reversed",
            formatVersion: 1,
            maxLines: null,
            palletId: null,
            documentId: DOCUMENT,
            partCount: 1,
            codeCount: 3,
            boxCount: 2,
            palletCount: 0,
            openPalletSuppressedBoxCount: 0,
          },
        ],
      ]);
      document.body.innerHTML = "";
    }
  });

  it("offers each format with its refusal and splits a format the source allows into parts", async () => {
    const source = rows();
    // Code C in the open box 3: no box format can cover it.
    source.items = source.items.map((item) =>
      item.codeHash === HASH_C ? { ...item, boxId: "b0000000-0000-4000-8000-000000000003" } : item,
    );
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, source, files);
    // Each radio is named by its label: the format, then a refused one's reason.
    expect(
      within(dialog())
        .getAllByRole("radio")
        .map((radio) => ({
          label: document.getElementById(radio.getAttribute("aria-labelledby") ?? "")?.textContent,
          disabled: radio.hasAttribute("disabled"),
        })),
    ).toEqual([
      { label: "[TXT][Без коробов] Отчет смены", disabled: false },
      {
        label: "[TXT][С коробами] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label:
          "[TXT][С коробами][Обратная] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      { label: "[CSV][Без коробов] Отчет смены", disabled: false },
      {
        label: "[CSV][С коробами] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label: "[XML][ГИСМТ] Отчет об агрегацииНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label: "[TXT][Паллеты] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label: "[CSV][Паллеты] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label:
          "[XML][ГИСМТ] Паллетная агрегацияНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label:
          "[TXT][Паллеты → короба] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label:
          "[XML][ГИСМТ] Агрегация паллет без кодовНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
    ]);
    fireEvent.click(
      within(dialog()).getByRole("radio", { name: "[TXT][Без коробов] Отчет смены" }),
    );
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "Разделить на части" }));
    const limit = within(dialog()).getByLabelText("Строк в части, не больше");
    fireEvent.change(limit, { target: { value: "1" } });
    expect(within(dialog()).getByText("Введите целое число от 2 до 1 000 000")).toBeTruthy();
    expect(
      within(dialog())
        .getByRole("button", { name: "Сформировать и сохранить" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(limit, { target: { value: "2" } });
    form();
    await within(dialog()).findByText(/^Сохранено файлов: 2\./);
    expect(files.save.mock.calls[0]?.[1]).toEqual(
      expectedParts(source, {
        formatId: "shift_txt_flat",
        formatVersion: 1,
        maxLines: 2,
        palletId: null,
      }),
    );
    expect(session.api.recordShiftExport.mock.calls[0]?.[2]).toMatchObject({
      formatId: "shift_txt_flat",
      maxLines: 2,
      partCount: 2,
      codeCount: 3,
      boxCount: 0,
    });
  });

  it("says the domain's refusal while forming, and saves and records nothing", async () => {
    const source = rows();
    source.organization.inn = "770123456789";
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, source, files);
    fireEvent.click(
      within(dialog()).getByRole("radio", { name: "[XML][ГИСМТ] Отчет об агрегации" }),
    );
    form();
    await within(dialog()).findByText(
      "ИНН организации — не 10 цифр. Документ для Честного знака формируется только для ИНН юридического лица из 10 цифр; ИНН индивидуального предпринимателя (12 цифр) программа пока не принимает. Проверьте ИНН на странице «Профиль организации».",
    );
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("says why the files were not saved, and records nothing", async () => {
    const files = fakeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("documents_unavailable", "no documents"));
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    form();
    await within(dialog()).findByText(
      "На этом компьютере не найдена папка «Документы». Файлы не сохранены.",
    );
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("says a record the host did not take, keeps the saved files and writes the same record again", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    session.api.recordShiftExport
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValueOnce(undefined);
    form();
    await within(dialog()).findByText(
      "Файлы сохранены, но запись в журнал действий не удалась. Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    expect(within(dialog()).getByText(/^Сохранено файлов: 1\./)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Записать снова" }));
    await waitFor(() =>
      expect(within(dialog()).queryByText(/запись в журнал действий не удалась/)).toBeNull(),
    );
    const [first, second] = session.api.recordShiftExport.mock.calls;
    expect(second).toEqual(first);
    expect(files.save).toHaveBeenCalledTimes(1);
  });

  it("forms one pallet's ЧЗ document of a shift still active; its shift formats wait for the close", async () => {
    const source = rows();
    source.shift.status = "active";
    const files = fakeFiles();
    const session = await openExport(
      { ...CLOSED_PALLETS, status: "active", closedAt: null },
      source,
      files,
    );
    expect(
      within(dialog())
        .getAllByRole("radio")
        .every((radio) => radio.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      within(dialog())
        .getByRole("button", { name: "Сформировать и сохранить" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "XML паллеты 146006820000000409" }),
    );
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    expect(files.save.mock.calls).toEqual([
      [
        ["Выгрузки", "OCT26-004", "2026-10-09_12-00-00_pallet_xml_gismt_aggregation"],
        expectedParts(source, {
          formatId: "pallet_xml_gismt_aggregation",
          formatVersion: 1,
          maxLines: null,
          palletId: PALLET_ID,
        }),
      ],
    ]);
    expect(session.api.recordShiftExport.mock.calls[0]?.[2]).toEqual({
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      maxLines: null,
      palletId: PALLET_ID,
      documentId: DOCUMENT,
      partCount: 1,
      codeCount: 0,
      boxCount: 1,
      palletCount: 1,
      openPalletSuppressedBoxCount: 0,
    });
  });

  it("warns of late data and of boxes on a pallet still open, and a pallet still open has no document", async () => {
    const source = rows();
    source.shift.lateDataAt = "2026-10-08T16:00:00Z";
    source.pallets.push({
      id: "a0000000-0000-4000-8000-000000000002",
      sscc: null,
      openedAt: "2026-10-08T06:07:15.902Z",
      closedAt: null,
      disassembledAt: null,
    });
    const box2 = source.boxes[1];
    if (box2 === undefined) throw new Error("the fixture has box 2");
    box2.palletId = "a0000000-0000-4000-8000-000000000002";
    await openExport(CLOSED_PALLETS, source, fakeFiles());
    fireEvent.click(within(dialog()).getByRole("radio", { name: "[TXT][Паллеты] Отчет смены" }));
    expect(
      within(dialog()).getByText(
        "После закрытия смены пришли данные (08.10.2026, 19:00:00): выгрузка их содержит, а выгрузка, сделанная до этого, устарела.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Коробов на незакрытых паллетах: 1. Они выгружены без паллеты; когда паллета закроется, выгрузите смену снова.",
      ),
    ).toBeTruthy();
    expect(within(dialog()).getByText("Паллета не закрыта, коробов: 1")).toBeTruthy();
    expect(
      within(dialog()).getByRole("button", { name: "XML паллеты —" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("closes on nothing and starts nothing else while an export runs", async () => {
    const files = fakeFiles();
    let finish: (saved: SavedFolder) => void = () => undefined;
    files.save.mockImplementation(
      () =>
        new Promise<SavedFolder>((resolve) => {
          finish = resolve;
        }),
    );
    await openExport(CLOSED_PALLETS, rows(), files);
    form();
    await waitFor(() => expect(files.save).toHaveBeenCalledTimes(1));
    const [cancel] = within(dialog()).getAllByRole("button", { name: "Закрыть" }).slice(1);
    expect(cancel?.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    form();
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "XML паллеты 146006820000000409" }),
    );
    expect(files.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    finish({ segments: ["Выгрузки", "OCT26-004", "x"], path: "C:\\x", files: ["a.txt"] });
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
  });
});

const GENERATION_FAILED = "Не удалось сформировать отчет. Повторите попытку.";

/** A pallet of the host's list for a count of boxes now and what the station counted. */
function listedPallet(boxes: number, reported: number | null): OfficePallet {
  return {
    id: PALLET_ID,
    deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    sscc: "146006820000000409",
    openedAt: "2026-10-08T06:06:01.118Z",
    closedAt: "2026-10-08T06:20:44.650Z",
    disassembledAt: null,
    boxes,
    units: 2,
    boxCountReported: reported,
    printVerifiedAt: null,
    printSkippedAt: null,
  };
}

describe("office shifts: an export's words, turns and care (plan ЧЗ, task 8)", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(DOCUMENT);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says each warning of the pallets formats in words, and only the late data for a flat one", async () => {
    // Pallet 1 counted 1 box at its close and holds 2 now (box 4 joined after it).
    await openExport(CLOSED_PALLETS, warnedExportRows(), fakeFiles(), undefined, [
      listedPallet(2, 1),
    ]);
    const late =
      "После закрытия смены пришли данные (08.10.2026, 19:00:00): выгрузка их содержит, а выгрузка, сделанная до этого, устарела.";
    expect(within(dialog()).getByText(late)).toBeTruthy();
    // The first format is flat: late data alone.
    expect(within(dialog()).queryByText(/незакрытых паллетах/)).toBeNull();
    fireEvent.click(within(dialog()).getByRole("radio", { name: "[TXT][Паллеты] Отчет смены" }));
    expect(within(dialog()).getByText(late)).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Коробов на незакрытых паллетах: 1. Они выгружены без паллеты; когда паллета закроется, выгрузите смену снова.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Расформированных паллет в документе: 1. Документ всё равно называет их вместе с коробами. Проверьте, нужно ли загружать такой документ в Честный знак.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Коробов, закрытых позже своей паллеты: 1. В документе они стоят на этой паллете, но этикетка паллеты, напечатанная при её закрытии, о них не знает.",
      ),
    ).toBeTruthy();
    await within(dialog()).findByText(
      "Паллет, у которых число коробов не совпадает со счётом станции: 1. Документ строится по коробам, которые есть сейчас, а не по счёту станции.",
    );
    // The pallet's own row names its late box.
    expect(within(dialog()).getByText("Коробов, закрытых позже паллеты: 1")).toBeTruthy();
    fireEvent.click(
      within(dialog()).getByRole("radio", { name: "[TXT][Без коробов] Отчет смены" }),
    );
    expect(within(dialog()).getByText(late)).toBeTruthy();
    expect(within(dialog()).queryByText(/Коробов, закрытых позже своей паллеты/)).toBeNull();
    expect(within(dialog()).queryByText(/число коробов не совпадает/)).toBeNull();
  });

  it("offers every warning inside one polite region whose alerts are not alerts as well", async () => {
    await openExport(CLOSED_PALLETS, warnedExportRows(), fakeFiles());
    const region = within(dialog())
      .getByText(/^После закрытия смены пришли данные/)
      .closest("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(region?.querySelectorAll('[role="presentation"]').length).toBeGreaterThan(0);
  });

  it("keeps the dialog whole when the host's list of pallets does not load", async () => {
    const files = fakeFiles();
    const session = await openExport(
      CLOSED_PALLETS,
      warnedExportRows(),
      files,
      undefined,
      [],
      (prepared) => prepared.api.listShiftPallets.mockRejectedValue(new Error("unreachable")),
    );
    await waitFor(() => expect(session.api.listShiftPallets).toHaveBeenCalledTimes(1));
    // Give the failed read the turns it needs to reach the dialog.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(within(dialog()).getByRole("radio", { name: "[TXT][Паллеты] Отчет смены" }));
    expect(within(dialog()).queryByText(/число коробов не совпадает/)).toBeNull();
    form();
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    expect(files.save).toHaveBeenCalledTimes(1);
  });

  it("asks the host for the pallets only when the shift has some", async () => {
    const source = rows();
    source.shift.palletsEnabled = false;
    const session = await openExport(
      { ...CLOSED_PALLETS, palletsEnabled: false },
      source,
      fakeFiles(),
    );
    expect(session.api.listShiftPallets).not.toHaveBeenCalled();
  });

  it("has words for every refusal, every warning and every refusal of the shell", async () => {
    const failures: Record<ExportFailure, true> = {
      SHIFT_NOT_CLOSED: true,
      SHIFT_HAS_NO_CODES: true,
      BOX_COVERAGE_INCOMPLETE: true,
      SHIFT_HAS_NO_PALLETS: true,
      PALLET_NOT_CLOSED: true,
      PALLET_DISASSEMBLED: true,
      ORG_INN_MISSING: true,
      ORG_NAME_MISSING: true,
      INVALID_ORG_INN: true,
      FORMAT_NOT_FOUND: true,
      INVALID_LINE_LIMIT: true,
      BOX_EXCEEDS_LINE_LIMIT: true,
      PALLET_EXCEEDS_LINE_LIMIT: true,
      INVALID_BOX_SSCC: true,
      INVALID_CIS: true,
      GENERATION_FAILED: true,
    };
    const warnings: Record<ExportWarning["kind"], true> = {
      late_data: true,
      open_pallets: true,
      disassembled_pallets: true,
      late_boxes: true,
      pallet_count_mismatch: true,
    };
    const files: Record<OfficeFilesCode, true> = {
      invalid_request: true,
      documents_unavailable: true,
      storage: true,
      unsupported: true,
    };
    const { default: ru } = await import("../src/i18n/ru.json");
    expect(Object.keys(ru.office.exports.failures).sort()).toEqual(Object.keys(failures).sort());
    expect(Object.keys(ru.office.exports.warnings).sort()).toEqual(Object.keys(warnings).sort());
    expect(Object.keys(ru.office.exports.files).sort()).toEqual(Object.keys(files).sort());
    for (const text of Object.values(ru.office.exports.failures))
      expect(text.length).toBeGreaterThan(10);
  });

  it("explains a refusal of the shell it can name: a name or path too long to save", async () => {
    const files = fakeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("invalid_request", "too long"));
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    form();
    await within(dialog()).findByText(
      "Файлы не сохранены: имя файла или путь к папке получились слишком длинными либо содержат недопустимый символ. В имени файла стоит название товара: сократите его в карточке товара, или выберите смену с более коротким названием, и повторите выгрузку.",
    );
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("says a refusal the shell gives for any other reason, and that the folder cannot be opened off Windows", async () => {
    const files = fakeFiles();
    files.save.mockRejectedValue(new Error("not a refusal of the shell"));
    files.open.mockRejectedValue(new OfficeFilesError("unsupported", "no explorer"));
    await openExport(CLOSED_PALLETS, rows(), files);
    form();
    await within(dialog()).findByText(
      "Не удалось записать файлы: проверьте место на диске и доступ к папке «Документы». Файлы не сохранены.",
    );
    files.save.mockImplementation(async (segments, list) => ({
      segments: [...segments],
      path: "C:\\x",
      files: list.map((file) => file.name),
    }));
    form();
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Открыть папку" }));
    await within(dialog()).findByText("Открыть папку можно только в Windows.");
  });

  it("shows what is not a refusal of the domain, with the kind of error and no code", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    // The rows read when the user forms the file carry an instant nobody can read.
    const broken = rows();
    broken.shift.stationClosedAt = null;
    broken.shift.closedAt = "not an instant";
    session.api.getShiftExportSource.mockResolvedValueOnce(broken);
    form();
    await within(dialog()).findByText(GENERATION_FAILED);
    expect(within(dialog()).getByText("Причина: RangeError")).toBeTruthy();
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("says the formats could not be checked, and forms nothing", async () => {
    const broken = rows();
    broken.shift.stationClosedAt = null;
    broken.shift.closedAt = "not an instant";
    await openDialog(CLOSED_PALLETS, broken, fakeFiles());
    await within(dialog()).findByText(
      "Не удалось проверить, какие форматы доступны этой смене. Закройте окно и откройте его снова.",
    );
    expect(within(dialog()).getByText("Причина: RangeError")).toBeTruthy();
    expect(within(dialog()).queryByRole("radiogroup")).toBeNull();
    expect(
      within(dialog())
        .getByRole("button", { name: "Сформировать и сохранить" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says the host's refusal when the rows cannot be read again, and forms nothing", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    session.api.getShiftExportSource.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    form();
    await within(dialog()).findByText(
      "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("can be cancelled while its rows are read: nothing is saved or recorded, and Escape cancels before it closes", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    const answer = deferred<ShiftExportRows>();
    session.api.getShiftExportSource.mockReturnValueOnce(answer.promise);
    form();
    const progress = await within(dialog()).findByText("Читаем данные смены…");
    expect(progress.closest('[role="status"]')).not.toBeNull();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    // At once: the host may be slow to answer, or never answer.
    await within(dialog()).findByText(
      "Формирование отменено. Файлы не сохранены, запись в журнал не сделана.",
    );
    answer.resolve(rows());
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Nothing runs now: the same Escape closes, and the format can be formed again.
    expect(within(dialog()).queryByRole("button", { name: "Отменить формирование" })).toBeNull();
    form();
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    expect(files.save).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape when nothing runs", async () => {
    await openExport(CLOSED_PALLETS, rows(), fakeFiles());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("has a button that cancels, and no cancel once the files are being saved", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    const answer = deferred<ShiftExportRows>();
    session.api.getShiftExportSource.mockReturnValueOnce(answer.promise);
    form();
    fireEvent.click(await within(dialog()).findByRole("button", { name: "Отменить формирование" }));
    await within(dialog()).findByText(/^Формирование отменено\./);
    answer.resolve(rows());
    expect(files.save).not.toHaveBeenCalled();
    let finish: (saved: SavedFolder) => void = () => undefined;
    files.save.mockImplementation(
      () =>
        new Promise<SavedFolder>((resolve) => {
          finish = resolve;
        }),
    );
    form();
    await within(dialog()).findByText("Сохраняем файлы…");
    expect(within(dialog()).queryByRole("button", { name: "Отменить формирование" })).toBeNull();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    finish({ segments: ["Выгрузки", "OCT26-004", "x"], path: "C:\\x", files: ["a.txt"] });
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    // The journal's row was written once, for the export that was saved.
    expect(session.api.recordShiftExport).toHaveBeenCalledTimes(1);
  });

  it("calls off an export asked to stop while the files are being formed, before anything is saved", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    // The click comes in the middle of the forming, the one stretch with no turn of its own.
    vi.mocked(crypto.randomUUID).mockImplementation(() => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Отменить формирование" }));
      return DOCUMENT;
    });
    form();
    await within(dialog()).findByText(/^Формирование отменено\./);
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("writes a record again once however many times it is asked in one turn", async () => {
    const session = await openExport(CLOSED_PALLETS, rows(), fakeFiles());
    session.api.recordShiftExport.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    form();
    const again = await within(dialog()).findByRole("button", { name: "Записать снова" });
    const second = deferred<undefined>();
    session.api.recordShiftExport.mockReturnValueOnce(second.promise);
    act(() => {
      fireEvent.click(again);
      fireEvent.click(again);
    });
    second.resolve(undefined);
    await waitFor(() =>
      expect(within(dialog()).queryByText(/запись в журнал действий не удалась/)).toBeNull(),
    );
    expect(session.api.recordShiftExport).toHaveBeenCalledTimes(2);
  });

  it("says in a polite region what it does, takes the focus there, and gives it to the result", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    const record = deferred<undefined>();
    session.api.recordShiftExport.mockReturnValueOnce(record.promise);
    form();
    const status = await within(dialog()).findByText("Записываем выгрузку в журнал действий…");
    expect(status.closest('[role="status"]')?.getAttribute("aria-live")).not.toBe("off");
    expect(document.activeElement).toBe(status.closest('[role="status"]'));
    record.resolve(undefined);
    const saved = (await within(dialog()).findByText(/^Сохранено файлов: 1\./)).closest(
      '[role="status"]',
    );
    await waitFor(() => expect(document.activeElement).toBe(saved));
  });

  it("gives the focus to a failure, which is an alert", async () => {
    const files = fakeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("storage", "disk"));
    await openExport(CLOSED_PALLETS, rows(), files);
    form();
    const failure = (await within(dialog()).findByText(/^Не удалось записать файлы/)).closest(
      '[role="alert"]',
    );
    expect(failure).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(failure));
  });

  it("starts one export however many times it is asked in one turn", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    const element = dialog().querySelector("form");
    if (element === null) throw new Error("the dialog has a form");
    act(() => {
      fireEvent.submit(element);
      fireEvent.submit(element);
    });
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    expect(session.api.getShiftExportSource).toHaveBeenCalledTimes(2);
    expect(files.save).toHaveBeenCalledTimes(1);
    expect(session.api.recordShiftExport).toHaveBeenCalledTimes(1);
  });

  it("leaves the screen a turn before it forms the files and a turn before it hands them to the shell", async () => {
    const events: string[] = [];
    const files = fakeFiles();
    files.save.mockImplementation(async (segments, list) => {
      events.push("save");
      return { segments: [...segments], path: "C:\\x", files: list.map((file) => file.name) };
    });
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    // Each mark is queued when its step begins, so it runs before any turn the step then gives up.
    session.api.getShiftExportSource.mockImplementationOnce(async () => {
      events.push("read");
      setTimeout(() => events.push("turn after read"), 0);
      return rows();
    });
    vi.mocked(crypto.randomUUID).mockImplementation(() => {
      events.push("form");
      setTimeout(() => events.push("turn after form"), 0);
      return DOCUMENT;
    });
    form();
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    expect(events).toEqual(["read", "turn after read", "form", "turn after form", "save"]);
  });

  it.each([
    [
      "the organization's zone",
      (session: FakeOfficeSession) =>
        session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Vladivostok" }),
      /^2026-10-09_19-00-00_shift_txt_flat$/,
    ],
    [
      "this PC's zone when the organization's is unknown",
      (session: FakeOfficeSession) =>
        session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Mars/Olympus" }),
      /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_shift_txt_flat$/,
    ],
    [
      "this PC's zone when the organization's profile is unread",
      (session: FakeOfficeSession) =>
        session.api.getOrg.mockRejectedValue(new Error("unreachable")),
      /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_shift_txt_flat$/,
    ],
  ])("names the folder by %s", async (_name, prepare, folder) => {
    const files = fakeFiles();
    await openExport(CLOSED_PALLETS, rows(), files, undefined, [], prepare);
    form();
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    expect(files.save.mock.calls[0]?.[0][2]).toMatch(folder);
  });

  it("reads the rows again when the dialog is opened again, never showing the last reading", async () => {
    const session = await openExport(CLOSED_PALLETS, rows(), fakeFiles());
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "Закрыть" })[1] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    session.api.getShiftExportSource.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: "Выгрузка смены OCT26-004" }));
    await screen.findByRole("dialog", { name: "Выгрузка смены OCT26-004" });
    expect(within(dialog()).getByText("Загрузка…")).toBeTruthy();
    expect(within(dialog()).queryByText(/^Проверяем, какие форматы/)).toBeNull();
    expect(session.api.getShiftExportSource).toHaveBeenCalledTimes(2);
  });

  it("shows how far the check of the formats has come while it makes it", async () => {
    const session = await openDialog(CLOSED_PALLETS, rows(), fakeFiles());
    expect(session.api.getShiftExportSource).toHaveBeenCalledTimes(1);
    await within(dialog()).findByText(/^Проверяем, какие форматы доступны: \d+ из 13…$/);
    await screen.findByRole("radiogroup");
    expect(within(dialog()).queryByText(/^Проверяем, какие форматы/)).toBeNull();
  });
});
