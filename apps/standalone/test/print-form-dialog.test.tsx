import { readFileSync } from "node:fs";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  boxReportRowsSchema,
  officeBoxSchema,
  officePalletSchema,
  palletReportRowsSchema,
  type OfficePallet,
  type OfficeShift,
  type PalletReportRows,
} from "../src/host/protocol.js";
import { OfficeFilesError } from "../src/office/exports/office-files.js";
import type { PrintForm } from "../src/office/forms/form-printer-context.js";
import { renderForm } from "../src/office/forms/render-form.js";
import { ORG_PROFILE, renderOffice, type FakeOfficeSession } from "./support/office.js";
import { fakeOfficeFiles, type FakeOfficeFiles } from "./support/office-files.js";
import { ACTIVE, LINE_10, NORTH, PALLET, PLANNED, shiftsSession, WATER } from "./support/shifts.js";

// Through a variable: Vite would take `new URL(…, import.meta.url)` for an asset.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const BOXES = officeBoxSchema.array().parse(fixture("office-boxes.json"));
const PALLETS = officePalletSchema.array().parse(fixture("office-pallets.json"));
const BOX_ROWS = boxReportRowsSchema.parse(fixture("box-report-rows.json"));
const PALLET_ROWS = palletReportRowsSchema.parse(fixture("pallet-report-rows.json"));
const PALLET_ID = PALLET_ROWS.pallets[0]?.id ?? "";

/** The fixtures' shift: active, with pallets. */
const SHIFT: OfficeShift = {
  ...ACTIVE,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET.id,
};

/** A second pallet, still open and so without an SSCC. */
const OPEN_PALLET: OfficePallet = {
  id: "a0000000-0000-4000-8000-000000000002",
  deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  sscc: null,
  openedAt: "2026-10-08T07:00:00.000Z",
  closedAt: null,
  disassembledAt: null,
  boxes: 1,
  units: 1,
  boxCountReported: null,
  printVerifiedAt: null,
  printSkippedAt: null,
};

afterEach(() => {
  vi.useRealTimers();
});

/** The office with `shift` listed and every read of its card and forms stubbed. */
function formSession(
  shift: OfficeShift,
  pallets: PalletReportRows = PALLET_ROWS,
): FakeOfficeSession {
  const session = shiftsSession([shift]);
  session.api.getShift.mockResolvedValue(shift);
  session.api.listShiftBoxes.mockResolvedValue(BOXES);
  session.api.listShiftPallets.mockResolvedValue(PALLETS);
  session.api.getBoxReportRows.mockResolvedValue(BOX_ROWS);
  session.api.getPalletReportRows.mockResolvedValue(pallets);
  return session;
}

/** Opens the card of `shift`, printing through `print` and saving through `files`. */
async function openCard(
  session: FakeOfficeSession,
  shift: OfficeShift,
  print: PrintForm,
  files: FakeOfficeFiles,
): Promise<void> {
  renderOffice(session, { printForm: print, files, initialPath: "/shifts" });
  fireEvent.click(await screen.findByRole("link", { name: `Карточка смены ${shift.number}` }));
  await screen.findByRole("heading", { name: `Смена ${shift.number}` });
}

/**
 * The button of one box's or one pallet's form: the card keeps them in the tab of the boxes or of
 * the pallets, so the tab is opened first.
 */
async function formButton(name: string): Promise<HTMLElement> {
  const tab = name.startsWith("Состав короба")
    ? "Короба"
    : /^(Состав|Ярлык) паллеты /.test(name)
      ? "Паллеты"
      : null;
  if (tab !== null) {
    const opened = await screen.findByRole("tab", { name: tab });
    if (opened.getAttribute("aria-selected") !== "true") fireEvent.click(opened);
  }
  return screen.findByRole("button", { name });
}

/** The dialog named `name`, once its form is drawable (its rows are read). */
async function readyDialog(name: string): Promise<HTMLElement> {
  const dialog = screen.getByRole("dialog", { name });
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  return dialog;
}

/** Freezes the clock at 2026-10-08 18:30:00 in Moscow, the organization's zone. */
function freezeClock(): Date {
  const now = new Date("2026-10-08T15:30:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  return now;
}

const BOX_FORM = "Состав короба (00)046006820000015000";

/** A promise settled by hand, for an answer the test holds back. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((onValue, onError) => {
    resolve = onValue;
    reject = onError;
  });
  return { promise, resolve, reject };
}

/** Lets the window's painting wait of a press (a frame, at most 100 ms) pass. */
async function afterPaint(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

const HOST_DOWN = () =>
  new HostError({ kind: "transport", code: "unreachable", message: "host down" });
const HOST_DOWN_TEXT = "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.";

/** Closes a dialog by its footer's «Закрыть» (the × of its title is named so too). */
function closeDialog(dialog: HTMLElement): void {
  const [footer] = within(dialog).getAllByRole("button", { name: "Закрыть" }).reverse();
  if (footer === undefined) throw new Error("the dialog has no «Закрыть»");
  fireEvent.click(footer);
}

describe("the printed forms of a shift's card (plan О-Ф)", () => {
  it("prints «Состав короба» of a box from its report rows, exactly as the cloud draws it", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    expect(session.api.getBoxReportRows).toHaveBeenCalledWith("office-session-token", BOX_ROWS.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    // The press reads the rows again and lets the window paint before it draws: not at once.
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print).toHaveBeenCalledWith(
      renderForm({ kind: "box", rows: BOX_ROWS, timeZone: ORG_PROFILE.timeZone })?.html,
    );
  });

  it("opens a form in the browser: saved as UTF-8 under «Формы» in a folder of its own, then the folder on request", async () => {
    freezeClock();
    const files = fakeOfficeFiles();
    await openCard(formSession(SHIFT), SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    const folder = ["Формы", "OCT26-004", "2026-10-08_18-30-00_box"];
    const name = "Состав короба 046006820000015000.html";
    await waitFor(() => expect(files.openFile).toHaveBeenCalledWith(folder, name));
    const html = renderForm({ kind: "box", rows: BOX_ROWS, timeZone: ORG_PROFILE.timeZone })?.html;
    expect(files.save).toHaveBeenCalledWith(folder, [
      { name, bytes: new TextEncoder().encode(html) },
    ]);
    // The browser has the form: the dialog goes by itself (beta 3.2), nothing to dismiss on return.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: BOX_FORM })).toBeNull());
  });

  it("closes the dialog by itself once the form is in the print window, and leaves it open when printing fails", async () => {
    const print = vi.fn<PrintForm>();
    await openCard(formSession(SHIFT), SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: BOX_FORM })).toBeNull());
  });

  it("keeps the dialog open when the form could not be opened in the browser", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValueOnce(new OfficeFilesError("storage", "disk"));
    await openCard(formSession(SHIFT), SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText(/Не удалось записать или открыть форму/);
    expect(screen.getByRole("dialog", { name: BOX_FORM })).toBeTruthy();
  });

  it("keeps the dialog open, with its warning, when the host could not keep a copy of the form", async () => {
    const session = formSession(SHIFT);
    session.api.beginExportFile.mockRejectedValue(HOST_DOWN());
    const files = fakeOfficeFiles();
    await openCard(session, SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText(/Форма открыта в браузере\./);
    fireEvent.click(within(dialog).getByRole("button", { name: "Показать папку" }));
    await waitFor(() => expect(files.open).toHaveBeenCalled());
  });

  it("keeps the form's exact HTML on the host, printed or opened, as a file of the box it came from", async () => {
    freezeClock();
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    const html = renderForm({ kind: "box", rows: BOX_ROWS, timeZone: ORG_PROFILE.timeZone })?.html;
    for (const [press, calls] of [
      ["Печать", 1],
      ["Открыть в браузере", 2],
    ] as const) {
      // The dialog closes by itself after each press: the next one opens it again.
      const open =
        calls === 1
          ? dialog
          : (fireEvent.click(await formButton(BOX_FORM)), await readyDialog(BOX_FORM));
      fireEvent.click(within(open).getByRole("button", { name: press }));
      await waitFor(() => expect(session.api.beginExportFile).toHaveBeenCalledTimes(calls));
      await afterPaint();
    }
    for (const [, begin] of session.api.beginExportFile.mock.calls) {
      expect(begin).toMatchObject({
        kind: "form",
        targetType: "box",
        targetId: BOX_ROWS.id,
        formatId: "form_box",
        formatVersion: 1,
        fileName: "Состав короба 046006820000015000.html",
      });
      const bytes = Uint8Array.from(atob(begin.contentBase64 ?? ""), (c) => c.charCodeAt(0));
      expect(new TextDecoder().decode(bytes)).toBe(html);
    }
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("prints all the same when the host cannot keep the form, and says so", async () => {
    const session = formSession(SHIFT);
    session.api.beginExportFile.mockRejectedValue(HOST_DOWN());
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await within(dialog).findByText(`Копия на хосте не сохранена: ${HOST_DOWN_TEXT}`);
  });

  it("says why a form was not opened in the browser, and opens nothing", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("documents_unavailable", "no folder"));
    await openCard(formSession(SHIFT), SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText(
      "На этом компьютере не найдена папка «Документы». Форма не сохранена.",
    );
    expect(files.openFile).not.toHaveBeenCalled();
  });

  it("offers a pallet's placard only when it is closed with an SSCC, on the paper chosen, and keeps the choice", async () => {
    const session = formSession(SHIFT);
    session.api.listShiftPallets.mockResolvedValue([...PALLETS, OPEN_PALLET]);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    await formButton("Состав паллеты Без SSCC");
    expect(screen.queryByRole("button", { name: "Ярлык паллеты Без SSCC" })).toBeNull();
    const placard = "Ярлык паллеты (00)146006820000000409";
    fireEvent.click(screen.getByRole("button", { name: placard }));
    let dialog = await readyDialog(placard);
    fireEvent.click(within(dialog).getByRole("radio", { name: "A5" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() =>
      expect(print).toHaveBeenLastCalledWith(
        renderForm({ kind: "placard", rows: PALLET_ROWS, palletId: PALLET_ID, format: "a5" })?.html,
      ),
    );
    closeDialog(dialog);
    fireEvent.click(screen.getByRole("button", { name: placard }));
    dialog = await readyDialog(placard);
    expect(within(dialog).getByRole("radio", { name: "A5" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("prints «Состав паллеты» and the shift's placards from the shift's pallet rows", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    const contents = "Состав паллеты (00)146006820000000409";
    fireEvent.click(await formButton(contents));
    let dialog = await readyDialog(contents);
    expect(within(dialog).queryByRole("radio")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() =>
      expect(print).toHaveBeenLastCalledWith(
        renderForm({
          kind: "pallet",
          rows: PALLET_ROWS,
          palletId: PALLET_ID,
          timeZone: ORG_PROFILE.timeZone,
        })?.html,
      ),
    );
    closeDialog(dialog);
    fireEvent.click(screen.getByRole("button", { name: "Ярлыки паллет смены" }));
    dialog = await readyDialog("Ярлыки паллет смены OCT26-004");
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() =>
      expect(print).toHaveBeenLastCalledWith(
        renderForm({ kind: "placards", rows: PALLET_ROWS, format: "a4" })?.html,
      ),
    );
    expect(session.api.getPalletReportRows).toHaveBeenCalledWith("office-session-token", SHIFT.id);
  });

  it("refuses the shift's placards when the rows read have no pallet to placard", async () => {
    const session = formSession(SHIFT, {
      ...PALLET_ROWS,
      pallets: PALLET_ROWS.pallets.map((pallet) => ({
        ...pallet,
        disassembledAt: "2026-10-08T07:00:00.000Z",
      })),
    });
    await openCard(session, SHIFT, vi.fn<PrintForm>(), fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Ярлыки паллет смены" }));
    const dialog = screen.getByRole("dialog", { name: "Ярлыки паллет смены OCT26-004" });
    await within(dialog).findByText("В смене нет закрытых паллет с SSCC: печатать нечего.");
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "Открыть в браузере" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("prints «Бланк смены» of a planned shift from the office's records, stamped with the moment of printing", async () => {
    const now = freezeClock();
    const print = vi.fn<PrintForm>();
    await openCard(formSession(PLANNED), PLANNED, print, fakeOfficeFiles());
    fireEvent.click(screen.getByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-005");
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() =>
      expect(print).toHaveBeenCalledWith(
        renderForm({
          kind: "task",
          inputs: {
            shift: PLANNED,
            product: WATER,
            line: LINE_10,
            counterparty: null,
            organization: ORG_PROFILE,
            photo: null,
          },
          generatedAt: now,
        })?.html,
      ),
    );
    // A planned shift has no placards to print.
    expect(screen.queryByRole("button", { name: "Ярлыки паллет смены" })).toBeNull();
  });

  it("prints the product's photo on «Бланк смены», read again at the press, and the blank without it when it does not read (plan ТОВ)", async () => {
    const photo = {
      width: 2,
      height: 1,
      dataBase64: "/9j/4AAQSkZJRgABAQ==",
      checksum: "ae0e381fa858d6782d6859eb9337b80e670dc0021361fdd55d49299f1b4c26fd",
      updatedAt: "2026-10-13T09:00:00.000Z",
    };
    const pictured = { ...WATER, photoChecksum: photo.checksum };
    const session = formSession(PLANNED);
    session.api.listProducts.mockResolvedValue([pictured]);
    session.api.getProductPhoto.mockResolvedValue({ photo });
    const print = vi.fn<PrintForm>();
    await openCard(session, PLANNED, print, fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-005");
    const reads = session.api.getProductPhoto.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(session.api.getProductPhoto.mock.calls.length).toBeGreaterThan(reads);
    expect(session.api.getProductPhoto).toHaveBeenCalledWith("office-session-token", WATER.id);
    expect(print.mock.calls[0]?.[0]).toContain(`src="data:image/jpeg;base64,${photo.dataBase64}"`);
    // The photo does not read at the next press: the blank prints without it.
    session.api.getProductPhoto.mockRejectedValue(new Error("offline"));
    // The first press closed the dialog; the second opens it again.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Бланк смены OCT26-005" })).toBeNull(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Бланк смены" }));
    const again = await readyDialog("Бланк смены OCT26-005");
    fireEvent.click(within(again).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    expect(print.mock.calls[1]?.[0]).toContain('class="product product--no-photo"');
  });

  it("offers «Бланк смены» when the photo does not read on opening, and prints it without the photo (plan ТОВ)", async () => {
    const pictured = { ...WATER, photoChecksum: "a".repeat(64) };
    const session = formSession(PLANNED);
    session.api.listProducts.mockResolvedValue([pictured]);
    session.api.getProductPhoto.mockRejectedValue(new Error("offline"));
    const print = vi.fn<PrintForm>();
    await openCard(session, PLANNED, print, fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-005");
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print.mock.calls[0]?.[0]).toContain('class="product product--no-photo"');
  });

  it("reads no photo for a product without one (plan ТОВ)", async () => {
    const session = formSession(PLANNED);
    const print = vi.fn<PrintForm>();
    await openCard(session, PLANNED, print, fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-005");
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(session.api.getProductPhoto).not.toHaveBeenCalled();
  });

  it("has no blank for a closed shift", async () => {
    const closed: OfficeShift = { ...SHIFT, status: "closed", closedAt: "2026-10-08T14:00:07Z" };
    await openCard(formSession(closed), closed, vi.fn<PrintForm>(), fakeOfficeFiles());
    await screen.findByRole("button", { name: "Ярлыки паллет смены" });
    expect(screen.queryByRole("button", { name: "Бланк смены" })).toBeNull();
  });

  it("says the window of printing did not open when printing fails", async () => {
    const print = vi.fn<PrintForm>(() => {
      throw new Error("no frame");
    });
    await openCard(formSession(SHIFT), SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(
      await within(dialog).findByText(
        "Окно печати не открылось. Откройте форму в браузере и напечатайте оттуда.",
      ),
    ).toBeTruthy();
  });
});

/** The same box with one more code, as a station may close it while the dialog is open. */
const NEWER_BOX_ROWS = {
  ...BOX_ROWS,
  items: [
    ...BOX_ROWS.items,
    {
      gtin14: "04600682000013",
      serial: "Zz9aNewCode1",
      canonical: "010460068200001321Zz9aNewCode1\u001d93Ef3X",
    },
  ],
};

describe("a form is drawn from the rows read at the press, and the press is safe (plan О-Ф)", () => {
  it("reads the rows again at the press and prints what it read, not what the dialog opened with", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    expect(session.api.getBoxReportRows).toHaveBeenCalledTimes(1);
    session.api.getBoxReportRows.mockResolvedValue(NEWER_BOX_ROWS);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(session.api.getBoxReportRows).toHaveBeenCalledTimes(2);
    const html = renderForm({
      kind: "box",
      rows: NEWER_BOX_ROWS,
      timeZone: ORG_PROFILE.timeZone,
    })?.html;
    expect(print).toHaveBeenCalledWith(html);
    expect(html).toContain("Zz9aNewCode1");
  });

  it("saves for the browser what it read at the press too", async () => {
    const session = formSession(SHIFT);
    const files = fakeOfficeFiles();
    await openCard(session, SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    session.api.getBoxReportRows.mockResolvedValue(NEWER_BOX_ROWS);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await waitFor(() => expect(files.openFile).toHaveBeenCalledTimes(1));
    const [, saved] = files.save.mock.calls[0] ?? [];
    expect(new TextDecoder().decode(saved?.[0]?.bytes)).toContain("Zz9aNewCode1");
  });

  it("draws from nothing the dialog's earlier opening cached: it waits for the read of this one", async () => {
    const session = formSession(SHIFT);
    await openCard(session, SHIFT, vi.fn<PrintForm>(), fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    closeDialog(await readyDialog(BOX_FORM));
    session.api.getBoxReportRows.mockImplementationOnce(() => new Promise(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: BOX_FORM }));
    const dialog = screen.getByRole("dialog", { name: BOX_FORM });
    await within(dialog).findByText("Загрузка…");
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "Открыть в браузере" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("says a read that failed when the dialog opened, and reads again on «Повторить»", async () => {
    const session = formSession(SHIFT);
    session.api.getBoxReportRows.mockRejectedValueOnce(HOST_DOWN());
    await openCard(session, SHIFT, vi.fn<PrintForm>(), fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = screen.getByRole("dialog", { name: BOX_FORM });
    await within(dialog).findByText(HOST_DOWN_TEXT);
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить" }));
    await readyDialog(BOX_FORM);
    expect(within(dialog).queryByText(HOST_DOWN_TEXT)).toBeNull();
  });

  it("prints nothing when the read at the press fails, says so, and prints after «Повторить»", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    session.api.getBoxReportRows.mockRejectedValueOnce(HOST_DOWN());
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText(HOST_DOWN_TEXT);
    await afterPaint();
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить" }));
    await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });

  it("says what it is doing while it works, keeps the button on the keyboard, and takes one press at a time", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    const files = fakeOfficeFiles();
    await openCard(session, SHIFT, print, files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    const read = deferred<typeof BOX_ROWS>();
    session.api.getBoxReportRows.mockImplementationOnce(() => read.promise);
    const printButton = within(dialog).getByRole("button", { name: "Печать" });
    const openButton = within(dialog).getByRole("button", { name: "Открыть в браузере" });
    printButton.focus();
    act(() => {
      fireEvent.click(printButton);
      fireEvent.click(openButton);
      fireEvent.click(printButton);
    });
    // Said in the polite region that was on the screen before it was said into.
    const progress = await within(dialog).findByText("Читаем актуальные данные…");
    expect(progress.closest('[aria-live="polite"]')).not.toBeNull();
    for (const button of [printButton, openButton]) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button).toHaveProperty("disabled", false);
    }
    expect(document.activeElement).toBe(printButton);
    expect(session.api.getBoxReportRows).toHaveBeenCalledTimes(2);
    await act(async () => {
      read.resolve(BOX_ROWS);
    });
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    // The print window is up: the dialog goes by itself (beta 3.2).
    await waitFor(() => expect(screen.queryByRole("dialog", { name: BOX_FORM })).toBeNull());
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.getBoxReportRows).toHaveBeenCalledTimes(2);
  });

  it("lets the window paint the progress before it draws a big form", async () => {
    const log: string[] = [];
    const frames = vi.spyOn(globalThis, "requestAnimationFrame");
    frames.mockImplementation((callback) => {
      log.push("frame");
      return window.setTimeout(() => callback(0), 0);
    });
    try {
      const print = vi.fn<PrintForm>(() => {
        log.push("print");
      });
      await openCard(formSession(SHIFT), SHIFT, print, fakeOfficeFiles());
      fireEvent.click(await formButton(BOX_FORM));
      const dialog = await readyDialog(BOX_FORM);
      fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
      await within(dialog).findByText("Рисуем форму…");
      await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
      expect(log).toEqual(["frame", "print"]);
    } finally {
      frames.mockRestore();
    }
  });

  it("abandons a press whose dialog was closed before the rows came: nothing is printed or saved", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    const files = fakeOfficeFiles();
    await openCard(session, SHIFT, print, files);
    fireEvent.click(await formButton(BOX_FORM));
    let dialog = await readyDialog(BOX_FORM);
    const read = deferred<typeof BOX_ROWS>();
    session.api.getBoxReportRows.mockImplementationOnce(() => read.promise);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    closeDialog(dialog);
    await act(async () => {
      read.resolve(BOX_ROWS);
    });
    await afterPaint();
    expect(print).not.toHaveBeenCalled();
    // The same for the browser's way.
    fireEvent.click(screen.getByRole("button", { name: BOX_FORM }));
    dialog = await readyDialog(BOX_FORM);
    const again = deferred<typeof BOX_ROWS>();
    session.api.getBoxReportRows.mockImplementationOnce(() => again.promise);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    closeDialog(dialog);
    await act(async () => {
      again.resolve(BOX_ROWS);
    });
    await afterPaint();
    expect(files.save).not.toHaveBeenCalled();
    expect(files.openFile).not.toHaveBeenCalled();
  });

  it("refuses a placard when the rows read now say the pallet is not closed, as the cloud does", async () => {
    const stillOpen: PalletReportRows = {
      ...PALLET_ROWS,
      pallets: PALLET_ROWS.pallets.map((pallet) => ({ ...pallet, closedAt: null })),
    };
    const session = formSession(SHIFT, stillOpen);
    await openCard(session, SHIFT, vi.fn<PrintForm>(), fakeOfficeFiles());
    const placard = "Ярлык паллеты (00)146006820000000409";
    fireEvent.click(await formButton(placard));
    const dialog = screen.getByRole("dialog", { name: placard });
    const refusal = await within(dialog).findByText(
      "Ярлык печатается только у закрытой паллеты с SSCC.",
    );
    expect(refusal.closest('[aria-live="polite"]')).not.toBeNull();
    // Heard once, by the region: the message is not an alert of its own.
    expect(within(dialog).queryByRole("alert")).toBeNull();
    for (const name of ["Печать", "Открыть в браузере"]) {
      expect(within(dialog).getByRole("button", { name })).toHaveProperty("disabled", true);
    }
  });

  it("says a pallet is not found when the rows read lack it", async () => {
    const session = formSession(SHIFT, { ...PALLET_ROWS, pallets: [] });
    await openCard(session, SHIFT, vi.fn<PrintForm>(), fakeOfficeFiles());
    const contents = "Состав паллеты (00)146006820000000409";
    fireEvent.click(await formButton(contents));
    const dialog = screen.getByRole("dialog", { name: contents });
    await within(dialog).findByText("Паллета не найдена.");
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty("disabled", true);
  });

  it("prints the placard of a pallet taken apart with the cloud's watermark, and offers no placards of the shift for it", async () => {
    const apart = "2026-10-08T07:00:00.000Z";
    const session = formSession(SHIFT, {
      ...PALLET_ROWS,
      pallets: PALLET_ROWS.pallets.map((pallet) => ({ ...pallet, disassembledAt: apart })),
    });
    session.api.listShiftPallets.mockResolvedValue(
      PALLETS.map((pallet) => ({ ...pallet, disassembledAt: apart })),
    );
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    const placard = "Ярлык паллеты (00)146006820000000409";
    fireEvent.click(await formButton(placard));
    const dialog = await readyDialog(placard);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print.mock.calls[0]?.[0]).toContain("РАСФОРМИРОВАНА");
    expect(screen.queryByRole("button", { name: "Ярлыки паллет смены" })).toBeNull();
  });

  it("reads the blank's records again at the press: a product renamed since the card opened is printed new", async () => {
    const session = formSession(PLANNED);
    const print = vi.fn<PrintForm>();
    await openCard(session, PLANNED, print, fakeOfficeFiles());
    fireEvent.click(screen.getByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-005");
    const renamed = { ...WATER, name: "Вода переименованная 0,5 л", printName: "Вода новая" };
    session.api.listProducts.mockResolvedValue([renamed]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print.mock.calls[0]?.[0]).toContain("Вода новая");
    expect(print.mock.calls[0]?.[0]).not.toContain(WATER.printName);
  });

  it("prints no blank when the records could not be read again, says why, and prints on the next press", async () => {
    const session = formSession(PLANNED);
    const print = vi.fn<PrintForm>();
    await openCard(session, PLANNED, print, fakeOfficeFiles());
    fireEvent.click(screen.getByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-005");
    session.api.listLines.mockRejectedValueOnce(HOST_DOWN());
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText(HOST_DOWN_TEXT);
    await afterPaint();
    expect(print).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty(
      "disabled",
      false,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(within(dialog).queryByText(HOST_DOWN_TEXT)).toBeNull();
  });

  it("refuses the blank when the shift was closed since the card opened", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(screen.getByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-004");
    session.api.getShift.mockResolvedValue({
      ...SHIFT,
      status: "closed",
      closedAt: "2026-10-08T14:00:07Z",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText(
      "Бланк печатается только у запланированной или активной смены.",
    );
    await afterPaint();
    expect(print).not.toHaveBeenCalled();
  });

  it("refuses at the press when the rows read then no longer give the form, and prints nothing", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    const placards = "Ярлыки паллет смены";
    fireEvent.click(await screen.findByRole("button", { name: placards }));
    const dialog = await readyDialog("Ярлыки паллет смены OCT26-004");
    session.api.getPalletReportRows.mockResolvedValue({
      ...PALLET_ROWS,
      pallets: PALLET_ROWS.pallets.map((pallet) => ({
        ...pallet,
        disassembledAt: "2026-10-08T07:00:00.000Z",
      })),
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText("В смене нет закрытых паллет с SSCC: печатать нечего.");
    await afterPaint();
    expect(print).not.toHaveBeenCalled();
  });

  it("says why the browser did not open the form, whoever failed, and tries again on the next press", async () => {
    const files = fakeOfficeFiles();
    files.openFile.mockRejectedValueOnce(new OfficeFilesError("storage", "no program"));
    files.save.mockRejectedValueOnce(new Error("disk"));
    await openCard(formSession(SHIFT), SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    const storage =
      "Не удалось записать или открыть форму: проверьте место на диске и доступ к папке «Документы».";
    // Not the shell's own error: still words, never the error's.
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText(storage);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Открыть в браузере" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await waitFor(() => expect(within(dialog).queryByText(storage)).toBeNull());
    await within(dialog).findByText(storage);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    // The third try opens the form: the dialog, and the old refusal in it, go away.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: BOX_FORM })).toBeNull());
  });

  it("says why the folder was not shown", async () => {
    const files = fakeOfficeFiles();
    files.open.mockRejectedValue(new OfficeFilesError("unsupported", "not windows"));
    // The dialog stays on the screen to offer the folder only while the host's copy warning is up.
    const session = formSession(SHIFT);
    session.api.beginExportFile.mockRejectedValue(HOST_DOWN());
    await openCard(session, SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Показать папку" }));
    await within(dialog).findByText("Открыть форму в браузере можно только в Windows.");
  });

  it("writes nothing to the console, whatever fails, so no code of a form is logged", async () => {
    const quiet = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const session = formSession(SHIFT);
      const files = fakeOfficeFiles();
      files.save.mockRejectedValueOnce(new OfficeFilesError("storage", "disk"));
      const print = vi.fn<PrintForm>(() => {
        throw new Error("no frame");
      });
      await openCard(session, SHIFT, print, files);
      fireEvent.click(await formButton(BOX_FORM));
      const dialog = await readyDialog(BOX_FORM);
      fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
      await within(dialog).findByText(/Окно печати не открылось/);
      session.api.getBoxReportRows.mockRejectedValueOnce(HOST_DOWN());
      fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
      await within(dialog).findByText(HOST_DOWN_TEXT);
      fireEvent.click(within(dialog).getByRole("button", { name: "Повторить" }));
      await readyDialog(BOX_FORM);
      fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
      await within(dialog).findByText(/Не удалось записать или открыть форму/);
      for (const spy of quiet) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of quiet) spy.mockRestore();
    }
  });

  it("prints a pallet of hundreds of boxes and a shift of hundreds of pallets, each in one press", async () => {
    const boxes = Array.from({ length: 600 }, (_, index) => ({
      id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      sscc: `0460068200${String(index).padStart(8, "0")}`,
      closedAt: "2026-10-08T06:06:01.118Z",
      disassembledAt: null,
      units: 12,
    }));
    const base = PALLET_ROWS.pallets[0];
    if (base === undefined) throw new Error("the fixture has no pallet");
    const pallets = Array.from({ length: 300 }, (_, index) => ({
      ...base,
      id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      sscc: `1460068200${String(index).padStart(8, "0")}`,
      closedAt: `2026-10-08T06:20:${String(index % 60).padStart(2, "0")}.000Z`,
      boxes: index === 0 ? boxes : base.boxes,
    }));
    const big: PalletReportRows = { ...PALLET_ROWS, pallets };
    const session = formSession(SHIFT, big);
    session.api.listShiftPallets.mockResolvedValue(
      pallets.map((pallet) => ({
        ...(PALLETS[0] as OfficePallet),
        id: pallet.id,
        sscc: pallet.sscc,
      })),
    );
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    const first = `Состав паллеты (00)${pallets[0]?.sscc}`;
    fireEvent.click(await formButton(first));
    let dialog = await readyDialog(first);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print.mock.calls[0]?.[0]).toContain("0460068200" + "00000599");
    closeDialog(dialog);
    fireEvent.click(screen.getByRole("button", { name: "Ярлыки паллет смены" }));
    dialog = await readyDialog("Ярлыки паллет смены OCT26-004");
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2), { timeout: 20_000 });
    expect(print.mock.calls[1]?.[0]).toBe(
      renderForm({ kind: "placards", rows: big, format: "a4" })?.html,
    );
  }, 60_000);
});

describe("the rest of the dialog's guards (plan О-Ф)", () => {
  it("says the blank cannot be drawn while a record it names did not load, and offers nothing", async () => {
    const session = formSession(PLANNED);
    session.api.getOrg.mockRejectedValue(HOST_DOWN());
    await openCard(session, PLANNED, vi.fn<PrintForm>(), fakeOfficeFiles());
    fireEvent.click(screen.getByRole("button", { name: "Бланк смены" }));
    const dialog = screen.getByRole("dialog", { name: "Бланк смены OCT26-005" });
    const text = await within(dialog).findByText(/бланк не из чего собрать/);
    expect(text.closest('[aria-live="polite"]')).not.toBeNull();
    // Not also «the blank is only of a planned or an active shift»: the blank is of one.
    expect(within(dialog).queryByText(/Бланк печатается только/)).toBeNull();
    for (const name of ["Печать", "Открыть в браузере"]) {
      expect(within(dialog).getByRole("button", { name })).toHaveProperty("disabled", true);
    }
  });

  it("prints the blank with the organization and the counterparty as they are at the press", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(screen.getByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-004");
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, name: "ООО «Прибой»" });
    session.api.listCounterparties.mockResolvedValue([
      { ...NORTH, name: "Контрагент Новый Север" },
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print.mock.calls[0]?.[0]).toContain("Прибой");
    expect(print.mock.calls[0]?.[0]).toContain("Контрагент Новый Север");
  });

  it("abandons a press whose dialog was closed while the form was being drawn, or saved", async () => {
    const print = vi.fn<PrintForm>();
    const files = fakeOfficeFiles();
    await openCard(formSession(SHIFT), SHIFT, print, files);
    fireEvent.click(await formButton(BOX_FORM));
    let dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText("Рисуем форму…");
    closeDialog(dialog);
    await afterPaint();
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: BOX_FORM }));
    dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText("Сохраняем форму и открываем браузер…");
    closeDialog(dialog);
    await afterPaint();
    expect(files.save).not.toHaveBeenCalled();
  });

  it("prints the shift's placards on the paper chosen, or saves them for the browser in a folder of their own", async () => {
    freezeClock();
    const print = vi.fn<PrintForm>();
    const files = fakeOfficeFiles();
    await openCard(formSession(SHIFT), SHIFT, print, files);
    fireEvent.click(await screen.findByRole("button", { name: "Ярлыки паллет смены" }));
    const dialog = await readyDialog("Ярлыки паллет смены OCT26-004");
    fireEvent.click(within(dialog).getByRole("radio", { name: "A5" }));
    const html = renderForm({ kind: "placards", rows: PALLET_ROWS, format: "a5" })?.html;
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledWith(html));
    // The print window is up: the dialog goes by itself; the next form opens it again.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Ярлыки паллет смены OCT26-004" })).toBeNull(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Ярлыки паллет смены" }));
    const again = await readyDialog("Ярлыки паллет смены OCT26-004");
    fireEvent.click(within(again).getByRole("radio", { name: "A5" }));
    fireEvent.click(within(again).getByRole("button", { name: "Открыть в браузере" }));
    await waitFor(() => expect(files.openFile).toHaveBeenCalledTimes(1));
    expect(files.save).toHaveBeenCalledWith(
      ["Формы", "OCT26-004", "2026-10-08_18-30-00_placards"],
      [{ name: "Ярлыки паллет смены A5.html", bytes: new TextEncoder().encode(html) }],
    );
  });

  it("does not wait for a frame a hidden window never draws", async () => {
    const frames = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 0);
    try {
      const print = vi.fn<PrintForm>();
      await openCard(formSession(SHIFT), SHIFT, print, fakeOfficeFiles());
      fireEvent.click(await formButton(BOX_FORM));
      const dialog = await readyDialog(BOX_FORM);
      fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
      await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
      expect(frames).toHaveBeenCalled();
    } finally {
      frames.mockRestore();
    }
  });

  it("holds the paper still while it works", async () => {
    const session = formSession(SHIFT);
    await openCard(session, SHIFT, vi.fn<PrintForm>(), fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Ярлыки паллет смены" }));
    const dialog = await readyDialog("Ярлыки паллет смены OCT26-004");
    const read = deferred<PalletReportRows>();
    session.api.getPalletReportRows.mockImplementationOnce(() => read.promise);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText("Читаем актуальные данные…");
    for (const radio of within(dialog).getAllByRole("radio")) {
      expect(radio).toHaveProperty("disabled", true);
    }
    await act(async () => {
      read.resolve(PALLET_ROWS);
    });
    // The print window opened: the dialog closes by itself (beta 3.2).
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Ярлыки паллет смены OCT26-004" })).toBeNull(),
    );
  });

  it("is not an alert of its own when the form was opened or failed: the polite region says it", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValueOnce(new OfficeFilesError("storage", "disk"));
    await openCard(formSession(SHIFT), SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await formButton(BOX_FORM));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    const failure = await within(dialog).findByText(/Не удалось записать или открыть форму/);
    expect(failure.closest('[aria-live="polite"]')).not.toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Открыть в браузере" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    // A success closes the dialog by itself; the failure above was said in the polite region.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: BOX_FORM })).toBeNull());
  });

  it("prints through a hidden frame of the window unless the office is given another way", async () => {
    // jsdom cannot print: the frame's window gets a printer of this test's, and nothing else is stubbed.
    const printed: string[] = [];
    const read = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow")?.get;
    const frames = vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get");
    frames.mockImplementation(function (this: HTMLIFrameElement) {
      const view = read?.call(this) as Window | null;
      if (view !== null && this.id === "office-print-frame") {
        view.focus = () => undefined;
        view.print = () => {
          printed.push(view.document.body.textContent ?? "");
        };
      }
      return view;
    });
    try {
      const session = formSession(SHIFT);
      renderOffice(session, { files: fakeOfficeFiles(), initialPath: "/shifts" });
      fireEvent.click(await screen.findByRole("link", { name: `Карточка смены ${SHIFT.number}` }));
      fireEvent.click(await formButton(BOX_FORM));
      const dialog = await readyDialog(BOX_FORM);
      fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
      await waitFor(() => expect(printed).toHaveLength(1));
      expect(printed[0]).toContain("Kq8vT2mXc5Rz");
      expect(document.getElementById("office-print-frame")).not.toBeNull();
    } finally {
      document.getElementById("office-print-frame")?.remove();
      frames.mockRestore();
    }
  });
});
