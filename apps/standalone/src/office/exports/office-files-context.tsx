import { createContext, useContext, type ReactNode } from "react";

import { createTauriOfficeFiles, type OfficeFilesApi } from "./office-files.js";

/** The shell's commands; a test passes its own through `Office`'s `files`. */
export const TAURI_OFFICE_FILES: OfficeFilesApi = createTauriOfficeFiles();

const OfficeFilesContext = createContext<OfficeFilesApi>(TAURI_OFFICE_FILES);

/** Gives the office below another way to save its files (tests). */
export function OfficeFilesProvider({
  value,
  children,
}: {
  value: OfficeFilesApi;
  children: ReactNode;
}) {
  return <OfficeFilesContext value={value}>{children}</OfficeFilesContext>;
}

/** Where the office saves its files. */
export function useOfficeFiles(): OfficeFilesApi {
  return useContext(OfficeFilesContext);
}
