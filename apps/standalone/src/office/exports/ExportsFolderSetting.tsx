import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input } from "@markiro/ui";

import { directoryProblem } from "../backups/backup-dir.js";
import { OfficeFilesError } from "./office-files.js";
import { useOfficeFiles } from "./office-files-context.js";

const KEY = ["office", "exports-folder"] as const;

/** The words for what stopped the folder dialog or its test file. */
function failureKey(error: unknown): string {
  if (error instanceof OfficeFilesError) {
    if (error.code === "unsupported") return "office.exportsFolder.unsupported";
    if (error.code === "folder_unavailable") return "office.exportsFolder.unavailable";
    if (error.code === "invalid_request") return "office.exportsFolder.notFull";
  }
  return "office.exportsFolder.failed";
}

/**
 * «Папка для выгрузок» (beta 3.2): where this PC writes the files of exports. The default is
 * `Документы\Markiro\Выгрузки`; «Выбрать папку…» opens the system's folder dialog (a shared
 * network folder may be chosen), and where the dialog is not available the path is typed. The
 * shell tries the folder with a test file before it keeps it, per PC. Forms stay in `Документы`.
 */
export function ExportsFolderSetting() {
  const { t } = useTranslation();
  const files = useOfficeFiles();
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: KEY, queryFn: () => files.getExportsFolder() });
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const shown = current.data?.path ?? current.data?.default ?? "";
  useEffect(() => {
    setDraft(shown);
  }, [shown]);

  async function apply(path: string | null): Promise<void> {
    setFailure(null);
    setSaved(false);
    setBusy(true);
    try {
      const answer = await files.setExportsFolder(path);
      queryClient.setQueryData(KEY, answer);
      setSaved(true);
    } catch (error) {
      setFailure(failureKey(error));
    } finally {
      setBusy(false);
    }
  }

  async function choose(): Promise<void> {
    setFailure(null);
    setSaved(false);
    let picked: string | null;
    try {
      picked = await files.pickFolder(t("office.exportsFolder.dialogTitle"));
    } catch (error) {
      setFailure(failureKey(error));
      return;
    }
    if (picked === null) return;
    setDraft(picked);
    await apply(picked);
  }

  const text = draft.trim();
  const problem = text === "" ? null : directoryProblem(text);
  const isDefault = current.data?.path === null || current.data === undefined;
  return (
    <div className="exports-folder">
      <Input
        label={t("office.exportsFolder.label")}
        hint={t("office.exportsFolder.hint")}
        mono
        value={draft}
        disabled={current.isPending}
        onChange={(event) => {
          setSaved(false);
          setDraft(event.target.value);
        }}
        {...(problem === null ? {} : { error: t(`office.backups.dirRules.${problem}`) })}
      />
      <div className="standalone-form__actions">
        <Button variant="secondary" disabled={busy} onClick={() => void choose()}>
          {t("office.pickFolder")}
        </Button>
        <Button
          disabled={busy || text === "" || problem !== null || text === shown}
          onClick={() => void apply(text)}
        >
          {t("office.common.save")}
        </Button>
        {!isDefault && (
          <Button variant="secondary" disabled={busy} onClick={() => void apply(null)}>
            {t("office.exportsFolder.reset")}
          </Button>
        )}
      </div>
      {failure !== null && (
        <Alert tone="error" role="presentation">
          {t(failure)}
        </Alert>
      )}
      <div aria-live="polite">
        {saved && (
          <Alert tone="ok" role="presentation">
            {t("office.exportsFolder.saved")}
          </Alert>
        )}
      </div>
    </div>
  );
}
