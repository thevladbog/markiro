import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, DefinitionGrid, FileDropZone } from "@markiro/ui";
import {
  HISTORY_CATEGORIES,
  readCloudHistoryBlob,
  type CloudHistoryManifest,
  type CloudHistoryImportState,
} from "../../host/cloud-history.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { requireHistoryTimeZone, UnsupportedHistoryTimeZoneError } from "./history-time-zone.js";
import { historyFailure } from "./history-errors.js";

/** Blob and parsed code records never enter React state, query/mutation caches, logs or storage. */
export function CloudHistoryImport() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const client = useQueryClient();
  const isAdmin = session.user.role === "admin";
  const remote = useOfficeQuery(
    officeKeys.historyState,
    (api, token) => api.getCloudHistoryState(token),
    { enabled: isAdmin },
  );
  const held = useRef<File | null>(null);
  const generation = useRef(0);
  const lock = useRef(false);
  const [view, setView] = useState<CloudHistoryManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<CloudHistoryImportState | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      held.current = null;
    },
    [],
  );
  const clear = () => {
    generation.current++;
    held.current = null;
    setView(null);
    setChecked(false);
    setFailure(null);
    setProgress(null);
  };
  const choose = async (file: File) => {
    if (lock.current) return;
    clear();
    const mine = generation.current;
    setBusy(true);
    try {
      let manifest: CloudHistoryManifest | null = null;
      for await (const row of readCloudHistoryBlob(file)) {
        if ("format" in row) {
          requireHistoryTimeZone(row.organization.timeZone);
          manifest = row;
        }
      }
      if (mine !== generation.current) return;
      held.current = file;
      setView(manifest);
    } catch (error) {
      if (mine === generation.current)
        setFailure(
          error instanceof UnsupportedHistoryTimeZoneError
            ? historyFailure(t, error)
            : t("office.cloudHistory.invalidFile"),
        );
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };
  const run = async (dryRun: boolean) => {
    const file = held.current;
    if (file === null || lock.current || !isAdmin || (!dryRun && !checked)) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    const mine = generation.current;
    try {
      const current = await session.call((token) => session.api.getCloudHistoryState(token));
      if (mine !== generation.current) return;
      let manifest: CloudHistoryManifest | null = null;
      for await (const row of readCloudHistoryBlob(file)) {
        if (mine !== generation.current) return;
        if ("format" in row) {
          requireHistoryTimeZone(row.organization.timeZone);
          manifest = row;
          if (current !== null && current.batchId !== row.checksum) {
            setFailure(t("office.cloudHistory.errors.history_batch_changed"));
            return;
          }
          continue;
        }
        if (manifest === null) throw new Error("history_manifest");
        setProgress(
          t(dryRun ? "office.cloudHistory.checkProgress" : "office.cloudHistory.importProgress", {
            done: row.index + 1,
            total: manifest.parts.length,
          }),
        );
        if (dryRun || !current?.receivedIndices.includes(row.index)) {
          const sourceManifest = manifest;
          const accepted = await session.call((token) =>
            session.api.importCloudHistory(token, { manifest: sourceManifest, part: row, dryRun }),
          );
          if (mine !== generation.current) return;
          if (!dryRun) client.setQueryData(officeKeys.historyState, accepted);
        }
      }
      if (manifest === null) throw new Error("history_manifest");
      if (dryRun) {
        setChecked(true);
        setProgress(t("office.cloudHistory.checked"));
        return;
      }
      const batchId = manifest.checksum;
      const completed = await session.call((token) =>
        session.api.completeCloudHistory(token, { batchId }),
      );
      if (mine !== generation.current) return;
      client.setQueryData(officeKeys.historyState, completed);
      held.current = null;
      setView(null);
      setChecked(false);
      setProgress(null);
      void client.invalidateQueries({ queryKey: officeKeys.cloudShifts });
    } catch (error) {
      if (mine === generation.current) {
        setFailure(historyFailure(t, error));
        void remote.refetch();
      }
    } finally {
      lock.current = false;
      if (mine === generation.current) setBusy(false);
    }
  };
  const cancel = async () => {
    const target = confirm;
    if (target === null || lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await session.call((token) =>
        session.api.cancelCloudHistory(token, { batchId: target.batchId }),
      );
      clear();
      if (target.replacementBackupFile !== undefined)
        setProgress(t("office.cloudImport.replacement.cancelWarning"));
      setConfirm(null);
      client.setQueryData(officeKeys.historyState, null);
      void remote.refetch();
    } catch (error) {
      setFailure(historyFailure(t, error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (!isAdmin) return <Alert tone="warn">{t("office.cloudHistory.adminRequired")}</Alert>;
  return (
    <Card title={t("office.cloudHistory.title")} titleAs="h2">
      <p className="office-note">{t("office.cloudHistory.intro")}</p>
      {remote.data?.replacementBackupFile !== undefined && (
        <>
          <DefinitionGrid
            items={[
              {
                id: "replacementBackup",
                term: t("office.cloudImport.replacement.backup"),
                description: remote.data.replacementBackupFile,
                mono: true,
              },
            ]}
          />
          {remote.data.status !== "complete" && (
            <Alert tone="warn">{t("office.cloudImport.replacement.resume")}</Alert>
          )}
        </>
      )}
      {remote.isError && (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" onClick={() => void remote.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {historyFailure(t, remote.error)}
        </Alert>
      )}
      {remote.data?.status === "complete" ? (
        <Alert tone="ok">{t("office.cloudHistory.done")}</Alert>
      ) : (
        <>
          {remote.data?.status === "pending" && (
            <Alert tone="warn">
              {t("office.cloudHistory.pending", {
                name: remote.data.source.tenantName,
                done: remote.data.receivedIndices.length,
                total: remote.data.totalParts,
              })}
            </Alert>
          )}
          <FileDropZone
            label={t("office.cloudHistory.choose")}
            hint={t("office.cloudHistory.chooseHint")}
            accept=".jsonl,application/x-ndjson"
            busy={busy}
            disabled={busy}
            onFile={(file) => void choose(file)}
            onRejected={() => {
              clear();
              setFailure(t("office.cloudHistory.invalidFile"));
            }}
          />
          {view !== null && (
            <>
              <DefinitionGrid
                items={[
                  {
                    id: "source",
                    term: t("office.cloudImport.source"),
                    description: view.source.tenantName,
                  },
                  { id: "window", term: t("office.cloudHistory.since"), description: view.since },
                  {
                    id: "exported",
                    term: t("office.cloudImport.exportedAt"),
                    description: view.exportedAt,
                  },
                  {
                    id: "org",
                    term: t("office.cloudImport.org"),
                    description: view.organization.name,
                  },
                  ...HISTORY_CATEGORIES.map((key) => ({
                    id: key,
                    term: t(`office.cloudHistory.counts.${key}`),
                    description: view.counts[key],
                  })),
                ]}
              />
              <div className="standalone-form__actions">
                <Button variant="secondary" disabled={busy} onClick={clear}>
                  {t("office.cloudImport.clear")}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => void run(true)}>
                  {t("office.cloudHistory.check")}
                </Button>
                <Button disabled={busy || !checked} onClick={() => void run(false)}>
                  {t(
                    remote.data?.status === "pending"
                      ? "office.cloudHistory.resume"
                      : "office.cloudHistory.import",
                  )}
                </Button>
              </div>
            </>
          )}
          {remote.data?.status === "pending" && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirm(remote.data ?? null)}
            >
              {t("office.cloudHistory.cancel")}
            </Button>
          )}
        </>
      )}
      {progress !== null && <p role="status">{progress}</p>}
      {failure !== null && !confirm && <Alert tone="error">{failure}</Alert>}
      {confirm !== null && (
        <FormDialog
          title={t("office.cloudHistory.cancel")}
          submitLabel={t("office.cloudHistory.cancelSubmit")}
          submitVariant="destructive"
          onSubmit={cancel}
          onClose={() => setConfirm(null)}
          alert={failure === null ? null : <Alert tone="error">{failure}</Alert>}
        >
          <p>
            {t(
              confirm.replacementBackupFile === undefined
                ? "office.cloudHistory.cancelWarning"
                : "office.cloudImport.replacement.cancelWarning",
              { name: confirm.source.tenantName },
            )}
          </p>
        </FormDialog>
      )}
    </Card>
  );
}
