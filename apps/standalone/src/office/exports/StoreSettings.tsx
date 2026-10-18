import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal, Select } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { ExportSettings } from "../../host/export-files.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import { ExportsFolderSetting } from "./ExportsFolderSetting.js";
import { fileSize } from "./StoredFiles.js";

/** «Хранить всегда» and the terms an administrator picks from, in days. */
const TERMS = [90, 180, 365, 730, 1095] as const;
const ALWAYS = "always";

/** The option value of a retention: the days as text, or «always». */
function termValue(days: number | null): string {
  return days === null ? ALWAYS : String(days);
}

/**
 * The retention of the files the host keeps (host migration `0029`): «Хранить
 * всегда» by default; an administrator may choose a term, and the host then
 * deletes the files older than it, which is asked about first. Everyone sees
 * what the store holds.
 */
export function StoreSettings() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const queryClient = useQueryClient();
  const settings = useOfficeQuery(officeKeys.exportSettings, (api, token) =>
    api.getExportSettings(token),
  );
  const save = useOfficeMutation((api, token, days: number | null) =>
    api.putExportSettings(token, { retentionDays: days }),
  );
  const [asked, setAsked] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const admin = user.role === "admin";

  async function apply(days: number | null): Promise<void> {
    setFailure(null);
    try {
      const saved = await save.mutateAsync(days);
      queryClient.setQueryData<ExportSettings>(officeKeys.exportSettings, saved);
      // A term deletes files: the lists of files are read again.
      await queryClient.invalidateQueries({ queryKey: officeKeys.exportFiles });
      await queryClient.invalidateQueries({ queryKey: ["office", "shift-exports"] });
    } catch (error) {
      setFailure(t(errorMessageKey(error)));
    }
  }

  const choose = (value: string) => {
    if (value === ALWAYS) {
      void apply(null);
      return;
    }
    setAsked(Number(value));
  };

  if (settings.isPending) return <PageLoading />;
  if (settings.isError) {
    return <LoadError error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  const current = settings.data;
  const terms = new Set<number>(TERMS);
  // A term set by another client stays on the list so the select can show it.
  if (current.retentionDays !== null) terms.add(current.retentionDays);
  const options = [
    { value: ALWAYS, label: t("office.storedFiles.settings.always") },
    ...[...terms]
      .sort((a, b) => a - b)
      .map((days) => ({
        value: String(days),
        label: t("office.storedFiles.settings.term", { days }),
      })),
  ];

  return (
    <div className="stored-files">
      <ExportsFolderSetting />
      <p className="office-note">
        {t("office.storedFiles.settings.holds", {
          count: current.fileCount,
          size: fileSize(current.originalBytes),
          stored: fileSize(current.storedBytes),
          max: fileSize(current.maxStoredBytes),
        })}
      </p>
      {admin ? (
        <Select
          label={t("office.storedFiles.settings.retention")}
          hint={t("office.storedFiles.settings.hint")}
          options={options}
          value={termValue(current.retentionDays)}
          disabled={save.isPending}
          onValueChange={choose}
        />
      ) : (
        <p className="office-note">
          {current.retentionDays === null
            ? t("office.storedFiles.settings.alwaysNote")
            : t("office.storedFiles.settings.termNote", { days: current.retentionDays })}
        </p>
      )}
      {failure !== null && (
        <Alert tone="error" role="presentation">
          {failure}
        </Alert>
      )}
      {asked !== null && (
        <Modal
          open
          title={t("office.storedFiles.settings.confirmTitle")}
          onClose={() => setAsked(null)}
          closeLabel={t("office.common.close")}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAsked(null)}>
                {t("office.common.cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const days = asked;
                  setAsked(null);
                  void apply(days);
                }}
              >
                {t("office.storedFiles.settings.confirm")}
              </Button>
            </>
          }
        >
          <p>{t("office.storedFiles.settings.confirmBody", { days: asked })}</p>
        </Modal>
      )}
    </div>
  );
}
