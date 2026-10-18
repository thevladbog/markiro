import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HEALTHY_BACKUPS } from "./support/backups.js";
import { ExportsFolderSetting } from "../src/office/exports/ExportsFolderSetting.js";
import { OfficeFilesProvider } from "../src/office/exports/office-files-context.js";
import { createTauriOfficeFiles, OfficeFilesError } from "../src/office/exports/office-files.js";
import { fakeOfficeFiles, type FakeOfficeFiles } from "./support/office-files.js";
import { fakeOfficeSession, ORG_PROFILE, renderOffice } from "./support/office.js";

const DEFAULT = "C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки";

function renderSetting(files: FakeOfficeFiles) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OfficeFilesProvider value={files}>
        <ExportsFolderSetting />
      </OfficeFilesProvider>
    </QueryClientProvider>,
  );
}

describe("«Папка для выгрузок» (beta 3.2)", () => {
  it("shows the default folder, and a folder chosen in the system dialog is kept at once", async () => {
    const files = fakeOfficeFiles();
    files.pickFolder.mockResolvedValue("\\\\SERVER\\Exports");
    renderSetting(files);
    const input = (await screen.findByLabelText("Папка для выгрузок")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(DEFAULT));
    expect(screen.queryByRole("button", { name: "По умолчанию" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать папку…" }));
    await waitFor(() => expect(files.setExportsFolder).toHaveBeenCalledWith("\\\\SERVER\\Exports"));
    expect(await screen.findByText(/Папка для выгрузок сохранена/)).toBeTruthy();
    expect(input.value).toBe("\\\\SERVER\\Exports");
    expect(await screen.findByRole("button", { name: "По умолчанию" })).toBeTruthy();
  });

  it("does nothing when the dialog is cancelled", async () => {
    const files = fakeOfficeFiles();
    renderSetting(files);
    await screen.findByDisplayValue(DEFAULT);
    fireEvent.click(screen.getByRole("button", { name: "Выбрать папку…" }));
    await waitFor(() => expect(files.pickFolder).toHaveBeenCalledTimes(1));
    expect(files.setExportsFolder).not.toHaveBeenCalled();
  });

  it("falls back to typing the path where the dialog is not available, and checks it as a full path", async () => {
    const files = fakeOfficeFiles();
    files.pickFolder.mockRejectedValue(new OfficeFilesError("unsupported", "not windows"));
    renderSetting(files);
    const input = await screen.findByDisplayValue(DEFAULT);
    fireEvent.click(screen.getByRole("button", { name: "Выбрать папку…" }));
    expect(await screen.findByText(/доступно только в Windows. Введите путь вручную/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Выгрузки" } });
    expect(screen.getByText(/Укажите полный путь/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: "E:\\Выгрузки" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(files.setExportsFolder).toHaveBeenCalledWith("E:\\Выгрузки"));
  });

  it("says why a folder was refused (no test file could be written) and keeps the old one", async () => {
    const files = fakeOfficeFiles();
    files.setExportsFolder.mockRejectedValue(new OfficeFilesError("folder_unavailable", "x"));
    renderSetting(files);
    const input = await screen.findByDisplayValue(DEFAULT);
    fireEvent.change(input, { target: { value: "\\\\SERVER\\Closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText(/не удалось записать пробный файл/)).toBeTruthy();
    expect(screen.queryByText(/сохранена/)).toBeNull();
  });

  it("goes back to the default folder", async () => {
    const files = fakeOfficeFiles();
    files.getExportsFolder.mockResolvedValue({ path: "E:\\Выгрузки", default: DEFAULT });
    renderSetting(files);
    await screen.findByDisplayValue("E:\\Выгрузки");
    fireEvent.click(screen.getByRole("button", { name: "По умолчанию" }));
    await waitFor(() => expect(files.setExportsFolder).toHaveBeenCalledWith(null));
  });
});

describe("«Путь ко второй папке» with the folder dialog (beta 3.2)", () => {
  async function openBackups(files: FakeOfficeFiles) {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, second: null });
    renderOffice(session, { files });
    fireEvent.click(await screen.findByRole("link", { name: "Резервные копии" }));
    await screen.findByLabelText("Путь ко второй папке");
    return session;
  }

  it("fills the field with the chosen folder and leaves saving to «Сохранить»", async () => {
    const files = fakeOfficeFiles();
    files.pickFolder.mockResolvedValue("\\\\NAS\\Backups");
    const session = await openBackups(files);
    fireEvent.click(screen.getByRole("button", { name: "Выбрать папку…" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Путь ко второй папке") as HTMLInputElement).value).toBe(
        "\\\\NAS\\Backups",
      ),
    );
    expect(session.api.updateBackupSettings).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("keeps the manual entry where the dialog is not available", async () => {
    const files = fakeOfficeFiles();
    files.pickFolder.mockRejectedValue(new OfficeFilesError("unsupported", "x"));
    await openBackups(files);
    fireEvent.click(screen.getByRole("button", { name: "Выбрать папку…" }));
    expect(await screen.findByText(/Введите путь вручную/)).toBeTruthy();
    expect(screen.getByLabelText("Путь ко второй папке")).toBeTruthy();
  });
});

describe("the shell's folder commands", () => {
  it("asks the dialog for a folder and reads null as a cancel", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const answers: unknown[] = ["E:\\Папка", null];
    const files = createTauriOfficeFiles(async (command, args) => {
      calls.push([command, args]);
      return answers.shift();
    });
    await expect(files.pickFolder("Заголовок")).resolves.toBe("E:\\Папка");
    await expect(files.pickFolder("Заголовок")).resolves.toBeNull();
    expect(calls[0]).toEqual(["pick_folder", { title: "Заголовок" }]);
  });

  it("reads the exports folder and sets it, refusing an answer of another shape", async () => {
    const call = vi.fn(async (command: string) =>
      command === "get_exports_folder" ? { path: null, default: "D" } : { path: "P", extra: 1 },
    );
    const files = createTauriOfficeFiles(call);
    await expect(files.getExportsFolder()).resolves.toEqual({ path: null, default: "D" });
    await expect(files.setExportsFolder("P")).rejects.toMatchObject({ code: "storage" });
    expect(call).toHaveBeenLastCalledWith("set_exports_folder", { path: "P" });
  });

  it("names the refusals of the dialog and of the test file", async () => {
    for (const code of ["unsupported", "folder_unavailable", "dialog_failed"] as const) {
      const files = createTauriOfficeFiles(async () => {
        throw code;
      });
      await expect(files.pickFolder("x")).rejects.toMatchObject({ code });
    }
  });
});
