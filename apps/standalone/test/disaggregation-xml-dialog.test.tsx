import { readFileSync } from "node:fs";

import { renderGismtDisaggregationXml } from "@markiro/domain";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  disaggregationDetailSchema,
  disaggregationReportRowsSchema,
  type DisaggregationDetail,
  type DisaggregationReportRows,
} from "../src/host/disaggregation.js";
import { OfficeFilesError } from "../src/office/exports/office-files.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { fakeOfficeFiles, type FakeOfficeFiles } from "./support/office-files.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));

const ROWS = disaggregationReportRowsSchema.parse(fixture("disaggregation-report-rows-boxes.json"));
const DETAIL: DisaggregationDetail = disaggregationDetailSchema.parse(
  fixture("disaggregation-detail.json"),
);
const APPLIED: DisaggregationDetail = {
  document: { ...DETAIL.document, status: "applied", docNo: "DSG-26-0007" },
  lines: DETAIL.lines,
};
const TOKEN = "office-session-token";
const TITLE = "Файл для Честного знака: DSG-26-0007";
const FOLDER = [
  "Выгрузки",
  "Дезагрегация",
  "DSG-26-0007",
  "2026-10-08_18-30-00_disaggregation_xml_gismt",
];

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function withHost(
  detail: DisaggregationDetail = APPLIED,
  rows: DisaggregationReportRows = ROWS,
  user = fakeOfficeSession().user,
): FakeOfficeSession {
  const session = fakeOfficeSession({ user });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listDisaggregationReasons.mockResolvedValue([]);
  session.api.listDisaggregations.mockResolvedValue([detail.document]);
  session.api.getDisaggregation.mockResolvedValue(detail);
  session.api.getDisaggregationReportRows.mockResolvedValue(rows);
  session.api.recordDisaggregationExport.mockResolvedValue(undefined);
  return session;
}

async function openDocument(session: FakeOfficeSession, files: FakeOfficeFiles): Promise<void> {
  renderOffice(session, { files });
  fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
  fireEvent.click(await screen.findByRole("link", { name: /^Открыть документ / }));
  await screen.findByRole("heading", { level: 1, name: /^Документ / });
}

async function openDialog(
  session: FakeOfficeSession,
  files: FakeOfficeFiles = fakeOfficeFiles(),
): Promise<HTMLElement> {
  await openDocument(session, files);
  fireEvent.click(await screen.findByRole("button", { name: "Файл для Честного знака" }));
  const dialog = await screen.findByRole("dialog", { name: TITLE });
  await waitFor(() => expect(within(dialog).queryByText("Загрузка…")).toBeNull());
  return dialog;
}

const BYTES = renderGismtDisaggregationXml({
  organizationInn: "7701234567",
  ssccs: ["046007034967000017", "146007034967100014"],
}).bytes;

describe("the ЧЗ file of an applied document (plan ДЗГ-О)", () => {
  it("has its button only on an applied document", async () => {
    const draft: DisaggregationDetail = {
      document: { ...DETAIL.document, status: "draft", docNo: "DSG-26-0007" },
      lines: DETAIL.lines,
    };
    await openDocument(withHost(draft), fakeOfficeFiles());
    expect(screen.queryByRole("button", { name: "Файл для Честного знака" })).toBeNull();
    expect(screen.getByRole("button", { name: "Акт дезагрегации" })).toBeTruthy();
  });

  it("shows the packages, the INN and the folder, and says the file is uploaded by hand", async () => {
    const session = withHost();
    const dialog = await openDialog(session);
    expect(session.api.getDisaggregationReportRows).toHaveBeenCalledWith(
      TOKEN,
      DETAIL.document.id,
      "boxes",
    );
    expect(within(dialog).getByText("Упаковок в файле").nextElementSibling?.textContent).toBe("2");
    expect(within(dialog).getByText("7701234567")).toBeTruthy();
    expect(within(dialog).getByText(/Выгрузки\\Дезагрегация\\DSG-26-0007/)).toBeTruthy();
    expect(
      within(dialog).getByText(/загружается в личный кабинет Честного знака вручную/),
    ).toBeTruthy();
  });

  it("warns of an organization without an INN and offers no button to form the file", async () => {
    const dialog = await openDialog(
      withHost(APPLIED, { ...ROWS, organization: { name: "ООО «Атолл»", inn: null } }),
    );
    expect(within(dialog).getByText(/Укажите ИНН организации/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Сформировать файл" })).toBeNull();
  });

  it("forms the generator's bytes from rows read again, saves them, then records the file", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T15:30:00.000Z"));
    const files = fakeOfficeFiles();
    const session = withHost();
    const dialog = await openDialog(session, files);
    expect(session.api.getDisaggregationReportRows).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await within(dialog).findByText(/Файл сохранён в папке:/);
    expect(session.api.getDisaggregationReportRows).toHaveBeenCalledTimes(2);
    expect(files.save).toHaveBeenCalledTimes(1);
    expect(files.save).toHaveBeenCalledWith(FOLDER, [
      { name: "disaggregation-DSG-26-0007.xml", bytes: BYTES },
    ]);
    expect(session.api.recordDisaggregationExport).toHaveBeenCalledWith(TOKEN, DETAIL.document.id, {
      formatId: "disaggregation_xml_gismt",
      formatVersion: 1,
      packingCount: 2,
    });
    // The file is saved before the record is asked for.
    const saved = files.save.mock.invocationCallOrder[0] ?? 0;
    const recorded = session.api.recordDisaggregationExport.mock.invocationCallOrder[0] ?? 0;
    expect(saved).toBeLessThan(recorded);
    fireEvent.click(within(dialog).getByRole("button", { name: "Показать папку" }));
    await waitFor(() => expect(files.open).toHaveBeenCalledWith(FOLDER));
  });

  it("says why the file was not saved and records nothing when neither the folder nor the host has it", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("invalid_request", "bad name"));
    const session = withHost();
    session.api.beginExportFile.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
    );
    const dialog = await openDialog(session, files);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await within(dialog).findByText(/Файлы не сохранены/);
    expect(session.api.recordDisaggregationExport).not.toHaveBeenCalled();
  });

  it("hands the host the generator's exact bytes first, as the document's own file", async () => {
    const files = fakeOfficeFiles();
    const session = withHost();
    const dialog = await openDialog(session, files);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await within(dialog).findByText(/Файл сохранён в папке:/);
    const [, begin] = session.api.beginExportFile.mock.calls[0] ?? [];
    expect(begin).toMatchObject({
      kind: "disaggregation_xml",
      targetType: "disaggregation_document",
      targetId: DETAIL.document.id,
      formatId: "disaggregation_xml_gismt",
      formatVersion: 1,
      partNo: 1,
      fileName: "disaggregation-DSG-26-0007.xml",
      sizeBytes: BYTES.length,
    });
    const sent = Uint8Array.from(atob(begin?.contentBase64 ?? ""), (c) => c.charCodeAt(0));
    expect([...sent]).toEqual([...BYTES]);
    const stored = session.api.beginExportFile.mock.invocationCallOrder[0] ?? 0;
    expect(stored).toBeLessThan(files.save.mock.invocationCallOrder[0] ?? 0);
  });

  it("records the file and says the host holds it when only the folder could not be written", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("storage", "disk"));
    const session = withHost();
    const dialog = await openDialog(session, files);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await within(dialog).findByText(/Файл сохранён на хосте: скачайте его из карточки документа/);
    expect(session.api.recordDisaggregationExport).toHaveBeenCalledTimes(1);
  });

  it("still saves the folder copy and records it when the host cannot keep the file, and says why", async () => {
    const files = fakeOfficeFiles();
    const session = withHost();
    session.api.beginExportFile.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "export_file_too_large",
        message: "big",
        status: 413,
        details: {},
      }),
    );
    const dialog = await openDialog(session, files);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await within(dialog).findByText(/Файл сохранён в папке:/);
    await within(dialog).findByText(
      "Копия на хосте не сохранена: Файл больше 256 МБ: хост его не хранит.",
    );
    expect(session.api.recordDisaggregationExport).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved file when the record is refused, and writes the same record again without saving twice", async () => {
    const files = fakeOfficeFiles();
    const session = withHost();
    session.api.recordDisaggregationExport.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
    );
    const dialog = await openDialog(session, files);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await within(dialog).findByText("Файл сохранён, но запись в журнал не прошла.");
    expect(files.save).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Записать снова" }));
    await waitFor(() => expect(session.api.recordDisaggregationExport).toHaveBeenCalledTimes(2));
    expect(session.api.recordDisaggregationExport.mock.calls[1]?.[2]).toEqual(
      session.api.recordDisaggregationExport.mock.calls[0]?.[2],
    );
    await waitFor(() =>
      expect(within(dialog).queryByText("Файл сохранён, но запись в журнал не прошла.")).toBeNull(),
    );
    expect(files.save).toHaveBeenCalledTimes(1);
  });

  it("does not form the file of a document that is no longer applied when the press reads it", async () => {
    const files = fakeOfficeFiles();
    const session = withHost();
    const dialog = await openDialog(session, files);
    session.api.getDisaggregationReportRows.mockResolvedValue({ ...ROWS, status: "cancelled" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await within(dialog).findAllByText("Файл формируется только по проведённому документу.");
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.recordDisaggregationExport).not.toHaveBeenCalled();
  });

  it("is as available to a technologist as to an administrator", async () => {
    const session = withHost(APPLIED, ROWS, TECHNOLOGIST);
    const dialog = await openDialog(session);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать файл" }));
    await waitFor(() => expect(session.api.recordDisaggregationExport).toHaveBeenCalledTimes(1));
  });

  it("holds a second press while the file is being formed", async () => {
    const session = withHost();
    const dialog = await openDialog(session);
    let release: (value: DisaggregationReportRows) => void = () => undefined;
    session.api.getDisaggregationReportRows.mockImplementationOnce(
      () =>
        new Promise<DisaggregationReportRows>((resolve) => {
          release = resolve;
        }),
    );
    const button = within(dialog).getByRole("button", { name: "Сформировать файл" });
    fireEvent.click(button);
    await within(dialog).findByText("Читаем документ…");
    fireEvent.click(button);
    await act(async () => {
      release(ROWS);
    });
    await waitFor(() => expect(session.api.recordDisaggregationExport).toHaveBeenCalledTimes(1));
  });
});
