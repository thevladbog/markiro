import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FileDropZone, Table, VisuallyHidden, type TableColumn } from "@markiro/ui";

import type { LicensePreview, OfficeLicense } from "../../../host/protocol.js";
import { licenseLoad } from "../../../host/requests.js";
import { officeKeys, useOfficeMutation } from "../../office-query.js";
import {
  comparisonRows,
  LICENSE_FILE_ACCEPT,
  loadedMessage,
  loadFailureText,
  overLimits,
  previewWarnings,
  readLicenseFile,
  type ComparisonRow,
} from "./license-load.js";
import type { LicenseText } from "./license-view.js";

type Message = { tone: "ok" | "warn" | "error"; text: LicenseText };

export interface LicenseLoadProps {
  license: OfficeLicense;
  zone: string | null;
}

/**
 * «Загрузить файл лицензии» (spec §4.8, §9.2): the file is read in the
 * webview (≤ 16 KiB), checked by the host without a write
 * (`POST /v1/office/license/preview`) and shown as «было → станет» with the
 * seats it would leave over their limit; «Загрузить» sends the same text
 * (`PUT /v1/office/license`), «Отмена» drops it. The latest picked file
 * wins; a second press while a load runs sends nothing. A refusal is said
 * in its own words and takes the focus. The text of the file stays in this
 * component's state, and in the mutation cache only while its check or load
 * runs (each write is reset once settled, `gcTime: 0`); it is never logged
 * nor put in the query cache. Without the organization's INN there
 * is nothing to bind a file to: the picker is off (the section links to
 * «Профиль организации»).
 */
export function LicenseLoad({ license, zone }: LicenseLoadProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const previewId = useId();
  const queryClient = useQueryClient();
  // The file's text is these writes' variables: each is reset once settled,
  // and `gcTime: 0` drops it from the mutation cache at once.
  const preview = useOfficeMutation(
    (api, token, file: string) => api.previewLicense(token, licenseLoad(file)),
    { gcTime: 0 },
  );
  const load = useOfficeMutation(
    (api, token, file: string) => api.loadLicense(token, licenseLoad(file)),
    { gcTime: 0 },
  );
  // The latest picked file wins: a slow read or check of an earlier one is dropped.
  const pick = useRef(0);
  const loading = useRef(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const [staged, setStaged] = useState<{ file: string; preview: LicensePreview } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  useEffect(() => {
    if (message?.tone === "error") messageRef.current?.focus();
  }, [message]);

  const say = (text: LicenseText) => t(text.key, text.values ?? {});

  const choose = async (file: File) => {
    const mine = ++pick.current;
    setMessage(null);
    setStaged(null);
    const read = await readLicenseFile(file);
    if (mine !== pick.current) return;
    if (read.kind !== "text") {
      setMessage({ tone: "error", text: { key: `office.about.license.load.${read.kind}` } });
      return;
    }
    let checked: LicensePreview;
    try {
      checked = await preview.mutateAsync(read.text);
    } catch (error) {
      if (mine === pick.current) {
        // A later pick's check may be running on this hook: only the latest resets it.
        preview.reset();
        setMessage({ tone: "error", text: loadFailureText(error, license) });
      }
      return;
    }
    if (mine === pick.current) {
      preview.reset();
      setStaged({ file: read.text, preview: checked });
    }
  };

  const submit = async () => {
    if (staged === null || loading.current) return;
    loading.current = true;
    setMessage(null);
    let next: OfficeLicense;
    try {
      next = await load.mutateAsync(staged.file);
    } catch (error) {
      load.reset();
      loading.current = false;
      setMessage({ tone: "error", text: loadFailureText(error, license) });
      return;
    }
    load.reset();
    loading.current = false;
    queryClient.setQueryData(officeKeys.license, next);
    setStaged(null);
    setMessage(loadedMessage(next, staged.preview.after, zone));
  };

  const columns: TableColumn<ComparisonRow>[] = [
    { key: "what", title: t("office.about.license.load.what"), render: (row) => say(row.label) },
    {
      key: "before",
      title: t("office.about.license.load.before"),
      wrap: true,
      render: (row) => say(row.before),
    },
    {
      key: "after",
      title: t("office.about.license.load.after"),
      wrap: true,
      render: (row) =>
        row.changed ? (
          <strong>
            {say(row.after)}
            <VisuallyHidden> ({t("office.about.license.load.changes")})</VisuallyHidden>
          </strong>
        ) : (
          say(row.after)
        ),
    },
  ];

  return (
    <section className="license-part" aria-labelledby={titleId}>
      <h3 id={titleId}>{t("office.about.license.load.title")}</h3>
      <div ref={messageRef} tabIndex={-1} className="backup-alerts" aria-live="polite">
        {message !== null && (
          <Alert tone={message.tone} role="presentation">
            {say(message.text)}
          </Alert>
        )}
      </div>
      {staged !== null && (
        <section className="license-part" aria-labelledby={previewId}>
          <h4 id={previewId}>{t("office.about.license.load.previewTitle")}</h4>
          <Table
            columns={columns}
            rows={comparisonRows(staged.preview, zone)}
            getRowKey={(row) => row.id}
            empty={t("office.about.license.load.none")}
          />
          {overLimits(staged.preview).map((row) => (
            <Alert key={row.key} tone="warn" role="presentation">
              {t("office.about.license.load.overLimit", {
                quota: t(`office.about.license.quotas.${row.key}`),
                used: row.used,
                limit: row.limit,
              })}
            </Alert>
          ))}
          {previewWarnings(staged.preview, zone).map((warning) => (
            <Alert key={warning.key} tone="warn" role="presentation">
              {say(warning)}
            </Alert>
          ))}
          <div className="standalone-form__actions">
            <Button loading={load.isPending} onClick={() => void submit()}>
              {t("office.about.license.load.submit")}
            </Button>
            <Button
              variant="secondary"
              disabled={load.isPending}
              onClick={() => {
                pick.current += 1;
                setStaged(null);
              }}
            >
              {t("office.about.license.load.cancel")}
            </Button>
          </div>
        </section>
      )}
      <FileDropZone
        compact
        label={t("office.about.license.load.drop")}
        busyLabel={t("office.about.license.load.busy")}
        accept={LICENSE_FILE_ACCEPT}
        busy={preview.isPending}
        disabled={load.isPending || license.binding.orgInn === null}
        onFile={(file) => void choose(file)}
        onRejected={() => {
          pick.current += 1;
          setStaged(null);
          setMessage({ tone: "error", text: { key: "office.about.license.load.wrongType" } });
        }}
      />
    </section>
  );
}
