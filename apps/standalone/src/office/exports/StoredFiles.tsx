import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import type { ExportFile } from "../../host/export-files.js";
import { errorMessageKey } from "../../host/errors.js";
import { exportFolder } from "./export-checks.js";
import { OfficeFilesError, type SavedFolder } from "./office-files.js";
import { useOfficeFiles } from "./office-files-context.js";
import { useOfficeSession } from "../office-session.js";
import { downloadErrorKey, fetchStoredFile } from "./stored-files.js";

/** A size for people: «18,2 КБ», «3,4 МБ». */
export function fileSize(bytes: number): string {
  const format = (value: number) =>
    new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(value);
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} КБ`;
  return `${format(bytes / (1024 * 1024))} МБ`;
}

/**
 * The folder a stored file goes to when it is downloaded again: where the
 * export dialog puts a new export, `Документы\Markiro\Выгрузки\<номер>\
 * <дата_время>_<формат>`, with the file's own moment and the shell adding
 * « (2)» to a folder that exists; the printed forms' root is `Формы`.
 */
export function downloadFolder(
  file: Pick<ExportFile, "kind" | "formatId" | "createdAt">,
  label: string,
  timeZone: string,
): string[] {
  const folder = exportFolder(label, file.formatId, file.createdAt, timeZone);
  return file.kind === "form" ? ["Формы", ...folder.slice(1)] : folder;
}

type Phase =
  { kind: "working" } | { kind: "saved"; saved: SavedFolder } | { kind: "failed"; message: string };

/**
 * «Скачать» for the files an export, a form or a card stored on the host: the
 * host checks the stored bytes against their SHA-256 (a damaged file is
 * refused and said so), the bytes are checked again here and then saved, byte
 * for byte, into a new folder under «Документы\Markiro» like a new export;
 * the result names the folder and offers to open it. A file of several parts
 * has «Скачать все» (one folder) besides a button for each part.
 */
export function StoredFiles({
  files,
  label,
  timeZone,
}: {
  files: readonly ExportFile[];
  /** What the folder is named by: a shift's number, a box's or pallet's SSCC, a document's number. */
  label: string;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const office = useOfficeFiles();
  const [phase, setPhase] = useState<Phase | null>(null);

  const [first] = files;
  if (first === undefined) return null;
  const working = phase?.kind === "working";

  async function download(chosen: readonly ExportFile[]): Promise<void> {
    const [head] = chosen;
    if (working || head === undefined) return;
    setPhase({ kind: "working" });
    try {
      const saving = [];
      for (const file of chosen) {
        saving.push({ name: file.fileName, bytes: await fetchStoredFile(session, file) });
      }
      const saved = await office.save(downloadFolder(head, label, timeZone), saving);
      setPhase({ kind: "saved", saved });
    } catch (error) {
      setPhase({
        kind: "failed",
        message:
          error instanceof OfficeFilesError
            ? t(`office.exports.files.${error.code}`)
            : t(downloadErrorKey(error)),
      });
    }
  }

  async function openFolder(saved: SavedFolder): Promise<void> {
    try {
      await office.open(saved.segments);
    } catch (error) {
      setPhase({
        kind: "failed",
        message:
          error instanceof OfficeFilesError
            ? t(`office.exports.files.${error.code}`)
            : t(errorMessageKey(error)),
      });
    }
  }

  return (
    <div className="stored-files">
      {files.length === 1 ? (
        <div className="stored-files__row">
          <span className="stored-files__name">
            {first.fileName}
            <span className="shift-cell__quiet"> · {fileSize(first.sizeBytes)}</span>
          </span>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.storedFiles.downloadNamed", { name: first.fileName })}
            {...(working ? { "aria-disabled": true as const } : {})}
            onClick={() => void download(files)}
          >
            {t("office.storedFiles.download")}
          </Button>
        </div>
      ) : (
        <>
          <Button
            variant="secondary"
            size="compact"
            {...(working ? { "aria-disabled": true as const } : {})}
            onClick={() => void download(files)}
          >
            {t("office.storedFiles.downloadAll", { count: files.length })}
          </Button>
          <details className="stored-files__parts">
            <summary>{t("office.storedFiles.parts", { count: files.length })}</summary>
            {files.map((file) => (
              <div className="stored-files__row" key={file.id}>
                <span className="stored-files__name">
                  {file.fileName}
                  <span className="shift-cell__quiet"> · {fileSize(file.sizeBytes)}</span>
                </span>
                <Button
                  variant="secondary"
                  size="compact"
                  aria-label={t("office.storedFiles.downloadNamed", { name: file.fileName })}
                  {...(working ? { "aria-disabled": true as const } : {})}
                  onClick={() => void download([file])}
                >
                  {t("office.storedFiles.download")}
                </Button>
              </div>
            ))}
          </details>
        </>
      )}
      {/* In the narrow cell of a table a banner would be squeezed to a column of letters: the
          result is a plain note, in the tone of what happened, and its button under it. */}
      <div aria-live="polite" className="stored-files__result">
        {working && <p className="office-note">{t("office.storedFiles.working")}</p>}
        {phase?.kind === "saved" && (
          <>
            <p className="stored-files__note stored-files__note--ok">
              {t("office.storedFiles.saved", { path: phase.saved.path })}
            </p>
            <Button variant="secondary" size="compact" onClick={() => void openFolder(phase.saved)}>
              {t("office.exports.openFolder")}
            </Button>
          </>
        )}
        {phase?.kind === "failed" && (
          <p className="stored-files__note stored-files__note--error" role="alert">
            {phase.message}
          </p>
        )}
      </div>
    </div>
  );
}
