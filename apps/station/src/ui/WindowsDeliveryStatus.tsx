import { decodeMonoRaster, productLabelBytesDigest } from "@markiro/domain";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@markiro/ui";
import { z } from "zod";
import type { SqlExecutor } from "../lib/mirror.js";
import { tauriWindowsPrinting, type WindowsJobObservation } from "../lib/hardware.js";
import { type PrintDeliveryRow, type DeliveryKey } from "../lib/print-deliveries.js";
import { LabelRasterPreview } from "./LabelRasterPreview.js";
type StatusRow = Omit<PrintDeliveryRow, "artifact_base64"> & { has_artifact: number };
const receiptSchema = z.strictObject({
  queue: z.string().min(1),
  jobId: z.number().int().positive(),
  documentName: z.string().min(1),
});
/** Queue observations are diagnostic: absence never means physically printed. */
export function WindowsDeliveryStatus({
  exec,
  scope,
  purpose,
  jobId,
  revision = 0,
  onAcknowledge,
}: {
  exec: SqlExecutor;
  scope: string;
  purpose: DeliveryKey["purpose"];
  jobId?: string;
  revision?: number | string;
  onAcknowledge?: (key: DeliveryKey) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [row, setRow] = useState<StatusRow | null>(null);
  const [observation, setObservation] = useState<WindowsJobObservation | null>(null);
  const [error, setError] = useState(false);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setRow(null);
    setBytes(null);
    setPreviewOpen(false);
    setError(false);
    setObservation(null);
    void (async () => {
      const [found] = await exec.all<StatusRow>(
        `SELECT scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,document_name,
          receipt_json,error_code,resolved_at,CASE WHEN purpose<>'duplicate' AND state NOT IN ('sent','failed_before_send') AND resolved_at IS NULL THEN 1 ELSE 0 END AS has_artifact
          FROM printer_deliveries WHERE scope=? AND purpose=? ${jobId === undefined ? "" : "AND job_id=?"}
          ORDER BY (resolved_at IS NULL AND state IN ('prepared','sending','delivery_unknown')) DESC,updated_at DESC,rowid DESC LIMIT 1`,
        jobId === undefined ? [scope, purpose] : [scope, purpose, jobId],
      );
      if (active) setRow(found ?? null);
    })().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, [exec, scope, purpose, jobId, revision, refresh]);
  useEffect(() => {
    if (!row || !previewOpen || bytes) return;
    let active = true;
    void (async () => {
      const [saved] = await exec.all<{ bytes: string | null }>(
        `SELECT artifact_base64 AS bytes FROM printer_deliveries
          WHERE scope=? AND purpose=? AND job_id=? AND attempt_id=? AND length(artifact_base64)>0
        UNION ALL SELECT json_extract(acceptance_json,'$.bytesBase64') AS bytes
          FROM product_label_accept_commands WHERE credential_ownership=? AND job_id=?
        UNION ALL SELECT COALESCE(json_extract(raster_json,'$.bytesBase64'),json_extract(job_json,'$.bytesBase64')) AS bytes
          FROM warehouse_reprint_jobs WHERE owner=? AND job_id=? LIMIT 1`,
        [
          row.scope,
          row.purpose,
          row.job_id,
          row.attempt_id,
          row.scope,
          row.job_id,
          row.scope,
          row.job_id,
        ],
      );
      if (!saved?.bytes) throw new Error("Saved raster unavailable");
      const page = Uint8Array.from(atob(saved.bytes), (c) => c.charCodeAt(0));
      if (productLabelBytesDigest(page) !== row.artifact_digest)
        throw new Error("Saved raster changed");
      decodeMonoRaster(page);
      if (active) setBytes(page);
    })().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, [exec, row, previewOpen, bytes]);
  if (!row) return error ? <p role="alert">{t("setup.windowsStatusUnavailable")}</p> : null;
  const receipt = receiptSchema.safeParse(parseJson(row.receipt_json));
  return (
    <section aria-label={t("setup.windowsDelivery")}>
      <p>{t(`setup.windowsState.${row.state}`)}</p>
      {receipt.success && (
        <>
          <p>
            {receipt.data.queue} · #{receipt.data.jobId}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              void tauriWindowsPrinting
                .getWindowsPrintJob(receipt.data)
                .then(setObservation)
                .catch(() => setObservation({ state: "unavailable" }));
            }}
          >
            {t("setup.windowsCheckQueue")}
          </Button>
        </>
      )}
      {observation && <p role="status">{t(`setup.windowsObservation.${observation.state}`)}</p>}
      {row.has_artifact || purpose === "duplicate" ? (
        <details
          key={row.attempt_id + ":" + String(revision)}
          onToggle={(event) => setPreviewOpen(event.currentTarget.open)}
        >
          <summary>{t("setup.windowsSavedPreview")}</summary>
          {bytes && <LabelRasterPreview bytes={bytes} label={t("setup.windowsSavedPreview")} />}
        </details>
      ) : null}
      {onAcknowledge && row.state !== "sending" && !row.resolved_at && (
        <Button
          variant="secondary"
          onClick={() => {
            void onAcknowledge({
              scope: row.scope,
              purpose: row.purpose,
              jobId: row.job_id,
              attemptId: row.attempt_id,
            })
              .then(() => setRefresh((value) => value + 1))
              .catch(() => setError(true));
          }}
        >
          {t("setup.windowsAcknowledge")}
        </Button>
      )}
      {error && <p role="alert">{t("setup.windowsStatusUnavailable")}</p>}
    </section>
  );
}

function parseJson(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
