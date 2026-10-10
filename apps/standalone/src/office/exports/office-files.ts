import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { bytesToBase64 } from "../../hardware/hardware.js";

/**
 * The shell's `save_office_files` and `open_office_folder`
 * (`src-tauri/src/office_files.rs`, plan ЧЗ): the office's files go into a
 * new folder under `Документы\Markiro\<segments…>`, the first segment one of
 * the shell's roots (`Выгрузки`, `Формы`); no file dialog.
 */

/** The codes the shell refuses with (`OfficeFilesError::code`). */
export const OFFICE_FILES_CODES = [
  "invalid_request",
  "documents_unavailable",
  "storage",
  "unsupported",
] as const;
export type OfficeFilesCode = (typeof OFFICE_FILES_CODES)[number];

export class OfficeFilesError extends Error {
  readonly code: OfficeFilesCode;

  constructor(code: OfficeFilesCode, message: string) {
    super(message);
    this.name = "OfficeFilesError";
    this.code = code;
  }
}

/** Where the files went: the segments as written (the last perhaps with « (2)»), the full path, the names. */
export const savedFolderSchema = z
  .object({ segments: z.array(z.string()), path: z.string(), files: z.array(z.string()) })
  .strict();
export type SavedFolder = z.infer<typeof savedFolderSchema>;

export interface OfficeFile {
  name: string;
  bytes: Uint8Array;
}

export interface OfficeFilesApi {
  /** Saves `files`, byte for byte, into a new folder `Документы\Markiro\<segments…>`. */
  save: (segments: readonly string[], files: readonly OfficeFile[]) => Promise<SavedFolder>;
  /** Shows a folder `save` made in Windows Explorer. */
  open: (segments: readonly string[]) => Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Over Tauri's `invoke`. A refusal is an `OfficeFilesError` of the shell's
 * code; anything else the shell or Tauri answers is `storage`, its words
 * kept in the message for the console, never on screen.
 */
export function createTauriOfficeFiles(call: Invoke = invoke): OfficeFilesApi {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code = OFFICE_FILES_CODES.find((candidate) => candidate === error);
      throw new OfficeFilesError(code ?? "storage", `${command}: ${String(error)}`);
    }
  }
  return {
    save: async (segments, files) => {
      const answer = await run("save_office_files", {
        segments: [...segments],
        files: files.map((file) => ({
          name: file.name,
          contentBase64: bytesToBase64(file.bytes),
        })),
      });
      const parsed = savedFolderSchema.safeParse(answer);
      if (!parsed.success) {
        throw new OfficeFilesError("storage", "save_office_files: an answer of another shape");
      }
      return parsed.data;
    },
    open: async (segments) => {
      await run("open_office_folder", { segments: [...segments] });
    },
  };
}
