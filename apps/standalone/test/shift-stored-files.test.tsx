import { createHash } from "node:crypto";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import { exportFileSchema, type ExportFile } from "../src/host/export-files.js";
import { OfficeFilesError } from "../src/office/exports/office-files.js";
import { StoredFiles } from "../src/office/exports/StoredFiles.js";
import { OfficeFilesProvider } from "../src/office/exports/office-files-context.js";
import { encodeBase64 } from "../src/office/exports/stored-files.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { fakeOfficeFiles } from "./support/office-files.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./support/office.js";
import { chooseText, shownIn } from "./support/select.js";
import { CLOSED, shiftsSession, PLANNED } from "./support/shifts.js";

const BATCH = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const TEXT = new TextEncoder().encode('<?xml version="1.0"?><a>Привет</a>\n');

function stored(part: number, bytes: Uint8Array, over: Partial<ExportFile> = {}): ExportFile {
  return exportFileSchema.parse({
    id: `7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e${part}`,
    batchId: BATCH,
    partNo: part,
    kind: "shift_export",
    targetType: "shift",
    targetId: CLOSED.id,
    shiftId: CLOSED.id,
    formatId: "shift_xml_gismt_aggregation_pallets",
    formatVersion: 1,
    fileName: `Отчет_${part}.xml`,
    mediaType: "application/xml; charset=utf-8",
    sizeBytes: bytes.length,
    sha256: sha(bytes),
    generator: "markiro-autonom test",
    createdAt: "2026-10-08T07:30:00Z",
    userName: "Иван Петров",
    ...over,
  });
}

/** The host serving `files` by the bytes in `bytesOf`, one chunk each. */
function serve(session: FakeOfficeSession, bytesOf: Record<string, Uint8Array>) {
  session.api.openExportFileDownload.mockImplementation(async (_token, id) => {
    const bytes = bytesOf[id];
    if (bytes === undefined) throw new Error("no such file");
    return { file: stored(1, bytes, { id }), chunkCount: 1 };
  });
  session.api.getExportFileChunk.mockImplementation(async (_token, id) => ({
    contentBase64: encodeBase64(bytesOf[id] ?? new Uint8Array()),
  }));
}

function history(files: ExportFile[]) {
  return {
    items: [
      {
        id: 42,
        recordedAt: "2026-10-08T07:30:00Z",
        userName: "Иван Петров",
        formatId: "shift_xml_gismt_aggregation_pallets",
        formatVersion: 1,
        maxLines: null,
        palletId: null,
        documentId: BATCH,
        partCount: files.length,
        codeCount: 3,
        boxCount: 2,
        palletCount: 1,
        openPalletSuppressedBoxCount: 0,
        files,
      },
    ],
  };
}

async function openExports(session: FakeOfficeSession, files = fakeOfficeFiles()) {
  session.api.getShift.mockResolvedValue(CLOSED);
  renderOffice(session, { files, initialPath: "/shifts" });
  await screen.findByRole("heading", { name: "Смены" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${CLOSED.number}` }));
  await screen.findByRole("heading", { name: `Смена ${CLOSED.number}` });
  fireEvent.click(screen.getByRole("tab", { name: "Выгрузки" }));
  await screen.findByRole("region", { name: "Выгрузки смены" });
  return files;
}

describe("the shift drawer's «Выгрузки»: the files the host kept (host migration 0029)", () => {
  it("downloads a stored file byte for byte into a new folder, after the host and this window checked it", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    const file = stored(1, TEXT);
    session.api.listShiftExports.mockResolvedValue(history([file]));
    serve(session, { [file.id]: TEXT });
    const files = await openExports(session);
    const region = screen.getByRole("region", { name: "Выгрузки смены" });
    fireEvent.click(
      await within(region).findByRole("button", { name: "Скачать файл Отчет_1.xml" }),
    );
    await within(region).findByText(/^Файл сохранён в папке:/);
    expect(session.api.openExportFileDownload).toHaveBeenCalledWith(
      "office-session-token",
      file.id,
    );
    expect(files.save).toHaveBeenCalledTimes(1);
    const [segments, saved] = files.save.mock.calls[0] ?? [];
    expect(segments?.[0]).toBe("Выгрузки");
    expect(segments?.[2]).toMatch(
      /^2026-10-08_\d\d-\d\d-\d\d_shift_xml_gismt_aggregation_pallets$/,
    );
    expect(saved?.map((each) => each.name)).toEqual(["Отчет_1.xml"]);
    expect([...(saved?.[0]?.bytes ?? [])]).toEqual([...TEXT]);
    fireEvent.click(within(region).getByRole("button", { name: "Открыть папку" }));
    await waitFor(() => expect(files.open).toHaveBeenCalledWith(segments));
  });

  it("offers every part of a split export in one folder, and each part alone", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    const second = new TextEncoder().encode("<b>вторая часть</b>");
    const parts = [stored(1, TEXT), stored(2, second)];
    session.api.listShiftExports.mockResolvedValue(history(parts));
    serve(session, { [parts[0]?.id ?? ""]: TEXT, [parts[1]?.id ?? ""]: second });
    const files = await openExports(session);
    const region = screen.getByRole("region", { name: "Выгрузки смены" });
    fireEvent.click(await within(region).findByRole("button", { name: "Скачать все (2)" }));
    await within(region).findByText(/^Файл сохранён в папке:/);
    expect(files.save.mock.calls[0]?.[1].map((each) => each.name)).toEqual([
      "Отчет_1.xml",
      "Отчет_2.xml",
    ]);
    fireEvent.click(within(region).getByRole("button", { name: "Скачать файл Отчет_2.xml" }));
    await waitFor(() => expect(files.save).toHaveBeenCalledTimes(2));
    expect(files.save.mock.calls[1]?.[1].map((each) => each.name)).toEqual(["Отчет_2.xml"]);
  });

  it("refuses a file the host says is damaged, and saves nothing", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    const file = stored(1, TEXT);
    session.api.listShiftExports.mockResolvedValue(history([file]));
    session.api.openExportFileDownload.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "export_file_corrupted",
        message: "x",
        status: 500,
        details: {},
      }),
    );
    const files = await openExports(session);
    const region = screen.getByRole("region", { name: "Выгрузки смены" });
    fireEvent.click(
      await within(region).findByRole("button", { name: "Скачать файл Отчет_1.xml" }),
    );
    await within(region).findByText(/^Файл на хосте повреждён/);
    expect(files.save).not.toHaveBeenCalled();
  });

  it("refuses bytes that arrive changed, though the host sent them, and saves nothing", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    const file = stored(1, TEXT);
    session.api.listShiftExports.mockResolvedValue(history([file]));
    const changed = TEXT.slice();
    changed.set([(changed[3] ?? 0) ^ 1], 3);
    session.api.openExportFileDownload.mockResolvedValue({ file, chunkCount: 1 });
    session.api.getExportFileChunk.mockResolvedValue({ contentBase64: encodeBase64(changed) });
    const files = await openExports(session);
    const region = screen.getByRole("region", { name: "Выгрузки смены" });
    fireEvent.click(
      await within(region).findByRole("button", { name: "Скачать файл Отчет_1.xml" }),
    );
    await within(region).findByText(/^Файл на хосте повреждён/);
    expect(files.save).not.toHaveBeenCalled();
  });

  it("says in words when the folder cannot be written, and keeps the file on the host", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    const file = stored(1, TEXT);
    session.api.listShiftExports.mockResolvedValue(history([file]));
    serve(session, { [file.id]: TEXT });
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("storage", "disk"));
    await openExports(session, files);
    const region = screen.getByRole("region", { name: "Выгрузки смены" });
    fireEvent.click(
      await within(region).findByRole("button", { name: "Скачать файл Отчет_1.xml" }),
    );
    await within(region).findByText(/^Не удалось записать файлы/);
  });

  it("says an export from before files were kept has none, and lists the shift's forms", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    session.api.listShiftExports.mockResolvedValue(history([]));
    const html = new TextEncoder().encode("<html>Бланк</html>");
    const form = stored(1, html, {
      kind: "form",
      formatId: "form_task",
      fileName: "Бланк смены.html",
      mediaType: "text/html; charset=utf-8",
      batchId: "11111111-2222-4333-8444-555555555555",
    });
    session.api.listExportFiles.mockResolvedValue({ items: [form] });
    serve(session, { [form.id]: html });
    const files = await openExports(session);
    const exports = screen.getByRole("region", { name: "Выгрузки смены" });
    expect(
      await within(exports).findByText("Файл не сохранён: сформируйте выгрузку заново"),
    ).toBeTruthy();
    expect(session.api.listExportFiles).toHaveBeenCalledWith("office-session-token", {
      shiftId: CLOSED.id,
      kind: "form",
    });
    const forms = screen.getByRole("region", { name: "Печатные формы смены" });
    fireEvent.click(within(forms).getByRole("button", { name: "Скачать файл Бланк смены.html" }));
    await within(forms).findByText(/^Файл сохранён в папке:/);
    expect(files.save.mock.calls[0]?.[0][0]).toBe("Формы");
  });
});

describe("the retention of the host's files", () => {
  const SETTINGS = {
    retentionDays: null,
    fileCount: 12,
    storedBytes: 3_145_728,
    originalBytes: 41_943_040,
    maxStoredBytes: 2_147_483_648,
  };

  it("is «Хранить всегда» by default and shows what the store holds", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    session.api.getExportSettings.mockResolvedValue(SETTINGS);
    await openExports(session);
    const region = screen.getByRole("region", { name: "Хранение файлов на хосте" });
    await within(region).findByText(/На хосте хранится файлов: 12, 40 МБ/);
    expect(shownIn("Срок хранения")).toBe("Хранить всегда");
  });

  it("asks before it sets a term that deletes files, then saves it and reads the lists again", async () => {
    const session = shiftsSession([CLOSED, PLANNED]);
    session.api.getExportSettings.mockResolvedValue(SETTINGS);
    session.api.putExportSettings.mockResolvedValue({
      ...SETTINGS,
      retentionDays: 365,
      fileCount: 7,
    });
    await openExports(session);
    const region = screen.getByRole("region", { name: "Хранение файлов на хосте" });
    await within(region).findByText(/На хосте хранится файлов: 12/);
    chooseText("Срок хранения", "365 дн.");
    const dialog = await screen.findByRole("dialog", { name: "Задать срок хранения файлов?" });
    expect(session.api.putExportSettings).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Задать срок и удалить" }));
    await waitFor(() =>
      expect(session.api.putExportSettings).toHaveBeenCalledWith("office-session-token", {
        retentionDays: 365,
      }),
    );
    await within(region).findByText(/На хосте хранится файлов: 7/);
  });

  it("is changed by an administrator only", async () => {
    const technologist = {
      id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
      login: "tech",
      name: "Павел Орлов",
      role: "technologist" as const,
    };
    const session = shiftsSession([CLOSED, PLANNED], technologist);
    session.api.getExportSettings.mockResolvedValue(SETTINGS);
    await openExports(session);
    const region = screen.getByRole("region", { name: "Хранение файлов на хосте" });
    await within(region).findByText("Файлы хранятся всегда. Срок хранения меняет администратор.");
    expect(within(region).queryByRole("combobox")).toBeNull();
  });
});

describe("StoredFiles on its own", () => {
  it("says nothing when it has no files", () => {
    const session = fakeOfficeSession();
    const { container } = render(
      <ThemeProvider defaultTheme="dark">
        <QueryClientProvider client={createOfficeQueryClient()}>
          <OfficeSessionProvider value={session}>
            <OfficeFilesProvider value={fakeOfficeFiles()}>
              <StoredFiles files={[]} label="X" timeZone="UTC" />
            </OfficeFilesProvider>
          </OfficeSessionProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(container.textContent).toBe("");
  });
});
