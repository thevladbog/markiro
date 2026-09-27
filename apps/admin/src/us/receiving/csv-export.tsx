import { useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import type { ReceivingLiveRecord } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";

type Props = {
  client: UsBrowserClient;
  record: ReceivingLiveRecord;
  canExport: boolean;
  dirty: boolean;
  disabled: boolean;
  onReload: () => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};

/** Downloads only bytes already verified by the US client; never stores an export. */
export function ReceivingCsvExport({
  client,
  record,
  canExport,
  dirty,
  disabled,
  onReload,
  onForbidden,
  onSessionLost,
}: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const busy = useRef(false);
  const run = useRef(0);
  const alive = useRef(true);
  const context = `${record.id}/${record.revision}/${record.draftVersion}/${record.lifecycle.lifecycleVersion}/${canExport}/${dirty}/${disabled}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  useEffect(() => {
    alive.current = true;
    busy.current = false;
    setPending(false);
    setErrorCode(null);
    setReady(false);
    return () => {
      alive.current = false;
      run.current += 1;
    };
  }, [context]);
  if (!canExport) return null;

  async function download() {
    if (busy.current || disabled || dirty || !canExport) return;
    const request = ++run.current;
    const capturedContext = context;
    busy.current = true;
    setPending(true);
    setErrorCode(null);
    setReady(false);
    try {
      const result = await client.exportReceivingCsv(record);
      if (!alive.current || request !== run.current || currentContext.current !== capturedContext)
        return;
      const bytes = new Uint8Array(new ArrayBuffer(result.bytes.byteLength));
      bytes.set(result.bytes);
      const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" }));
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        document.body.append(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
        }
      } finally {
        URL.revokeObjectURL(url);
      }
      setReady(true);
    } catch (error) {
      if (!alive.current || request !== run.current || currentContext.current !== capturedContext)
        return;
      const code = error instanceof UsClientError ? error.code : "invalid_response";
      setErrorCode(code);
      if (code === "session_required") onSessionLost();
      if (code === "forbidden") await onForbidden();
    } finally {
      if (alive.current && request === run.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  const message =
    errorCode === "receiving_export_stale"
      ? t("receivingCsv.exportStale")
      : errorCode === "export_value_too_large"
        ? t("receivingCsv.exportTooLarge")
        : errorCode === "session_required" || errorCode === "forbidden"
          ? t("receivingCsv.exportAccess")
          : errorCode === "unavailable"
            ? t("receivingCsv.exportUnavailable")
            : t("receivingCsv.exportInvalid");
  return (
    <section className="us-rec-csv-actions" aria-label={t("receivingCsv.exportSection")}>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled || dirty || pending}
        onClick={() => void download()}
      >
        {pending ? t("receivingCsv.exportPending") : t("receivingCsv.exportAction")}
      </Button>
      {dirty ? <p className="us-rec-hint">{t("receivingCsv.exportDirty")}</p> : null}
      <p className="us-rec-hint">{t("receivingCsv.exportHint")}</p>
      {ready ? <p role="status">{t("receivingCsv.exportReady")}</p> : null}
      {errorCode ? (
        <div role="alert">
          <p>{message}</p>
          {errorCode === "receiving_export_stale" ? (
            <Button type="button" variant="secondary" onClick={onReload}>
              {t("receivingCsv.exportReload")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
