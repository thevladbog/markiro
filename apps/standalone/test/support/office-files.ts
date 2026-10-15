import { vi, type Mock } from "vitest";

import type { OfficeFilesApi, SavedFolder } from "../../src/office/exports/office-files.js";

/** The office's files as a test sees them: every command a mock. */
export type FakeOfficeFiles = { [K in keyof OfficeFilesApi]: Mock<OfficeFilesApi[K]> };

/** A shell that saves into `C:\Users\Оператор\Documents\Markiro\<segments>`, shows and opens. */
export function fakeOfficeFiles(): FakeOfficeFiles {
  return {
    save: vi.fn<OfficeFilesApi["save"]>(async (segments, files): Promise<SavedFolder> => ({
      segments: [...segments],
      path: `C:\\Users\\Оператор\\Documents\\Markiro\\${segments.join("\\")}`,
      files: files.map((file) => file.name),
    })),
    open: vi.fn<OfficeFilesApi["open"]>(async () => undefined),
    openFile: vi.fn<OfficeFilesApi["openFile"]>(async () => undefined),
    pickFolder: vi.fn<OfficeFilesApi["pickFolder"]>(async () => null),
    getExportsFolder: vi.fn<OfficeFilesApi["getExportsFolder"]>(async () => ({
      path: null,
      default: "C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки",
    })),
    setExportsFolder: vi.fn<OfficeFilesApi["setExportsFolder"]>(async (path) => ({
      path,
      default: "C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки",
    })),
  };
}
