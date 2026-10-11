import { describe, expect, it } from "vitest";

import {
  createTauriOfficeFiles,
  OfficeFilesError,
  type OfficeFilesCode,
} from "../src/office/exports/office-files.js";

/** A shell that records each call and answers `answer`, or refuses with it. */
function shell(answer: unknown, refuse = false) {
  const calls: [string, Record<string, unknown>][] = [];
  const files = createTauriOfficeFiles(async (command, args) => {
    calls.push([command, args]);
    if (refuse) throw answer;
    return answer;
  });
  return { files, calls };
}

const SEGMENTS = ["Выгрузки", "OCT26-004", "2026-10-08_18-30-00_shift_csv_flat"];
const SAVED = {
  segments: SEGMENTS,
  path: "C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки\\OCT26-004\\2026-10-08_18-30-00_shift_csv_flat",
  files: ["Молоко_1pcs_2026-10-08.csv"],
};

describe("the office's files over the shell (plan ЧЗ)", () => {
  it("sends each file's bytes base64-encoded, the CSV's BOM and CRLF included, and reads the folder", async () => {
    const { files, calls } = shell(SAVED);
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x63, 0x0d, 0x0a, 0x1d);
    await expect(
      files.save(SEGMENTS, [{ name: "Молоко_1pcs_2026-10-08.csv", bytes }]),
    ).resolves.toEqual(SAVED);
    expect(calls).toEqual([
      [
        "save_office_files",
        {
          segments: SEGMENTS,
          files: [{ name: "Молоко_1pcs_2026-10-08.csv", contentBase64: "77u/Yw0KHQ==" }],
        },
      ],
    ]);
  });

  it("shows a folder by its segments", async () => {
    const { files, calls } = shell(null);
    await files.open(SEGMENTS);
    expect(calls).toEqual([["open_office_folder", { segments: SEGMENTS }]]);
  });

  it("opens a form's file by its folder and its name (plan О-Ф)", async () => {
    const { files, calls } = shell(null);
    const form = ["Формы", "OCT26-004", "2026-10-08_18-30-00_task"];
    await files.openFile(form, "Бланк смены.html");
    expect(calls).toEqual([["open_office_file", { segments: form, name: "Бланк смены.html" }]]);
    await expect(shell("unsupported", true).files.openFile(form, "a.html")).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it.each(["invalid_request", "documents_unavailable", "storage", "unsupported"] as const)(
    "turns the shell's %s into an error of that code",
    async (code: OfficeFilesCode) => {
      const save = shell(code, true).files.save(SEGMENTS, []);
      await expect(save).rejects.toBeInstanceOf(OfficeFilesError);
      await expect(save).rejects.toMatchObject({ code });
      await expect(shell(code, true).files.open(SEGMENTS)).rejects.toMatchObject({ code });
      await expect(shell(code, true).files.openFile(SEGMENTS, "a.html")).rejects.toMatchObject({
        code,
      });
    },
  );

  it("reads anything else the shell refuses with, and an answer of another shape, as storage", async () => {
    await expect(
      shell("state not managed for field `state`", true).files.save(SEGMENTS, []),
    ).rejects.toMatchObject({ code: "storage" });
    await expect(shell({ ...SAVED, extra: 1 }).files.save(SEGMENTS, [])).rejects.toMatchObject({
      code: "storage",
    });
  });
});
