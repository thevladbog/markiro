import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  OfficeFilesProvider,
  TAURI_OFFICE_FILES,
  useOfficeFiles,
} from "../src/office/exports/office-files-context.js";
import type { OfficeFilesApi } from "../src/office/exports/office-files.js";

function Probe({ onFiles }: { onFiles: (files: OfficeFilesApi) => void }) {
  onFiles(useOfficeFiles());
  return null;
}

describe("where the office saves its files (plan ЧЗ)", () => {
  it("is the shell's commands unless a provider says otherwise", () => {
    let seen: OfficeFilesApi | null = null;
    render(<Probe onFiles={(files) => (seen = files)} />);
    expect(seen).toBe(TAURI_OFFICE_FILES);
  });

  it("is what the nearest provider gives", () => {
    const own: OfficeFilesApi = {
      save: () => Promise.reject(new Error("not here")),
      open: () => Promise.resolve(),
      openFile: () => Promise.resolve(),
    };
    let seen: OfficeFilesApi | null = null;
    render(
      <OfficeFilesProvider value={own}>
        <Probe onFiles={(files) => (seen = files)} />
      </OfficeFilesProvider>,
    );
    expect(seen).toBe(own);
    expect(seen).not.toBe(TAURI_OFFICE_FILES);
  });
});
