import { decodeMonoRaster, productLabelBytesDigest } from "@markiro/domain";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@markiro/ui";
import { z } from "zod";
import type { SqlExecutor } from "../lib/mirror.js";
import { tauriWindowsPrinting, type WindowsJobObservation } from "../lib/hardware.js";
import {
  recoverPrintDeliveries,
  resolvePrintDelivery,
  type PrintDeliveryRow,
  type DeliveryKey,
} from "../lib/print-deliveries.js";
import { LabelRasterPreview } from "./LabelRasterPreview.js";
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
  allowAcknowledge = false,
}: {
  exec: SqlExecutor;
  scope: string;
  purpose: DeliveryKey["purpose"];
  jobId?: string;
  revision?: number | string;
  allowAcknowledge?: boolean;
}) {
  const { t } = useTranslation();
  const [row, setRow] = useState<PrintDeliveryRow | null>(null);
  const [observation, setObservation] = useState<WindowsJobObservation | null>(null);
  const [error, setError] = useState(false);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setRow(null);
    setBytes(null);
    setError(false);
    setObservation(null);
    void (async () => {
      await recoverPrintDeliveries(exec);
      if (purpose === "test")
        await exec.run(
          "DELETE FROM printer_deliveries WHERE scope=? AND purpose='test' AND resolved_at IS NOT NULL AND state<>'sending'",
          [scope],
        );
      const [found] = await exec.all<PrintDeliveryRow>(
        `SELECT * FROM printer_deliveries WHERE scope=? AND purpose=? ${jobId === undefined ? "" : "AND job_id=?"} ORDER BY (resolved_at IS NULL AND state IN ('prepared','sending','delivery_unknown')) DESC,updated_at DESC,rowid DESC LIMIT 1`,
        jobId === undefined ? [scope, purpose] : [scope, purpose, jobId],
      );
      if (active) setRow(found ?? null);
      if (found) {
        let encoded = found.artifact_base64;
        if (!encoded && purpose === "duplicate") {
          const [saved] = await exec.all<{ bytes: string }>(
            `SELECT json_extract(acceptance_json,'$.bytesBase64') AS bytes FROM product_label_accept_commands WHERE credential_ownership=? AND job_id=?
            UNION ALL SELECT json_extract(job_json,'$.bytesBase64') AS bytes FROM warehouse_reprint_jobs WHERE owner=? AND job_id=? LIMIT 1`,
            [scope, found.job_id, scope, found.job_id],
          );
          encoded = saved?.bytes ?? null;
        }
        if (encoded) {
          const page = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
          if (productLabelBytesDigest(page) !== found.artifact_digest)
            throw new Error("Saved raster changed");
          decodeMonoRaster(page);
          if (active) setBytes(page);
        }
      }
    })().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, [exec, scope, purpose, jobId, revision, refresh]);
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
      {bytes && (
        <details>
          <summary>{t("setup.windowsSavedPreview")}</summary>
          <LabelRasterPreview bytes={bytes} label={t("setup.windowsSavedPreview")} />
        </details>
      )}
      {allowAcknowledge && row.state !== "sending" && !row.resolved_at && (
        <Button
          variant="secondary"
          onClick={() => {
            void resolvePrintDelivery(exec, {
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
