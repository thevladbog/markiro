import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal, RadioGroup } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { DisaggregationReportVariant } from "../../host/disaggregation.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { useRefreshStoredFiles } from "../exports/use-refresh-files.js";
import { OfficeFilesError, type SavedFolder } from "../exports/office-files.js";
import { usePrintForm } from "../forms/form-printer-context.js";
import { actFolder, openInBrowser, paint } from "../forms/print-form.js";
import { storeForm } from "../forms/store-form.js";
import { prepareForm } from "../forms/render-form.js";
import { readFormLogo } from "../branding.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";

export interface DisaggregationActDialogProps {
  documentId: string;
  docNo: string;
  /** `formTimeZone(org)`: the act's times are the organization's. */
  timeZone: string;
  onClose: () => void;
}

/** Where a press is: the data is read again, the act is drawn, the file is saved. */
type Stage = "reading" | "drawing" | "saving";

type Outcome = { kind: "opened"; saved: SavedFolder } | { kind: "failed"; message: string };

const VARIANTS: readonly DisaggregationReportVariant[] = ["boxes", "full"];

/**
 * «Акт дезагрегации» of a document (plan ДЗГ-О), the cloud's act drawn by
 * `@markiro/domain` from the host's rows. The dialog reads them when it
 * opens, and each press reads them AGAIN before it draws (a station can
 * close a box, or an apply can change the document, while the dialog is
 * open); it then prints in the office's window («Печать») or saves the act
 * under `Документы\Markiro\Формы\Дезагрегация` and opens it in the default
 * browser («Открыть в браузере»). The two variants are the cloud's: the
 * packages' codes only, or with each box's codes and each pallet's boxes.
 * The draw of a big one is the heavy step: the press says what it is doing
 * and lets the window paint it first, and closing the dialog abandons the
 * press before anything is printed or saved. Every office role prints.
 */
export function DisaggregationActDialog({
  documentId,
  docNo,
  timeZone,
  onClose,
}: DisaggregationActDialogProps) {
  const { t } = useTranslation();
  const files = useOfficeFiles();
  const print = usePrintForm();
  const session = useOfficeSession();
  const queryClient = useQueryClient();
  const refreshFiles = useRefreshStoredFiles();
  const [hostCopy, setHostCopy] = useState<string | null>(null);
  const [variant, setVariant] = useState<DisaggregationReportVariant>("boxes");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const rows = useOfficeQuery(officeKeys.disaggregationReport(documentId, variant), (api, token) =>
    api.getDisaggregationReportRows(token, documentId, variant),
  );
  const busy = stage !== null;
  // Not the answer of an earlier opening: it is read again, and until it is (our own
  // press reads too, and keeps the buttons where they are) nothing is offered.
  const reading = rows.isPending || (rows.isFetching && !busy);
  const failed = !reading && rows.isError;
  const drawable = !reading && !failed;

  function failureText(error: unknown, at: Stage | null): string {
    if (error instanceof OfficeFilesError) return t(`office.forms.files.${error.code}`);
    return at === "reading" ? t(errorMessageKey(error)) : t("office.forms.files.storage");
  }

  async function press(how: "print" | "open"): Promise<void> {
    if (inFlight.current || !drawable) return;
    inFlight.current = true;
    let at: Stage = "reading";
    setStage(at);
    setOutcome(null);
    setHostCopy(null);
    try {
      const answer = await rows.refetch();
      if (answer.isError || answer.data === undefined) return;
      // A dialog closed while the rows were read is found out after the paint, before any draw.
      at = "drawing";
      setStage(at);
      await paint();
      if (!alive.current) return;
      // The organization's own logo, when the license allows custom branding; else Markiro's.
      const logo = await readFormLogo(queryClient, session.api, session.call);
      if (!alive.current) return;
      const form = prepareForm({ kind: "act", rows: answer.data, timeZone, logo });
      if (form === null) return;
      const html = form.draw();
      // The host keeps the exact HTML first, printed or opened; a host that cannot never stops the act.
      const kept = await storeForm(
        session,
        { kind: form.kind, html, fileName: form.fileName },
        { type: "disaggregation_document", id: documentId },
      );
      refreshFiles();
      if (alive.current) setHostCopy(kept === null ? null : t(kept));
      if (how === "print") {
        try {
          print(html);
        } catch {
          setOutcome({ kind: "failed", message: t("office.forms.printFailed") });
        }
        return;
      }
      at = "saving";
      setStage(at);
      await paint();
      if (!alive.current) return;
      const folder = actFolder(docNo, variant, new Date().toISOString(), timeZone);
      const saved = await openInBrowser(
        files,
        { kind: form.kind, html, fileName: form.fileName },
        folder,
      );
      if (alive.current) setOutcome({ kind: "opened", saved });
    } catch (error) {
      if (alive.current) setOutcome({ kind: "failed", message: failureText(error, at) });
    } finally {
      inFlight.current = false;
      if (alive.current) setStage(null);
    }
  }

  async function showFolder(saved: SavedFolder): Promise<void> {
    try {
      await files.open(saved.segments);
    } catch (error) {
      if (alive.current) setOutcome({ kind: "failed", message: failureText(error, null) });
    }
  }

  const waiting = busy ? { "aria-disabled": true as const } : {};

  return (
    <Modal
      open
      title={t("office.disaggregation.act.title", { docNo })}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("office.common.close")}
          </Button>
          <Button
            variant="secondary"
            disabled={!drawable}
            {...waiting}
            onClick={() => void press("open")}
          >
            {t("office.forms.openInBrowser")}
          </Button>
          <Button disabled={!drawable} {...waiting} onClick={() => void press("print")}>
            {t("office.forms.print")}
          </Button>
        </>
      }
    >
      <RadioGroup
        label={t("office.disaggregation.act.variant")}
        name="act-variant"
        value={variant}
        disabled={busy}
        onValueChange={(value) => {
          setOutcome(null);
          setVariant(VARIANTS.find((each) => each === value) ?? "boxes");
        }}
        options={VARIANTS.map((each) => ({
          value: each,
          label: t(`office.disaggregation.act.variants.${each}`),
        }))}
      />
      {reading ? (
        <PageLoading />
      ) : failed ? (
        <LoadError error={rows.error} onRetry={() => void rows.refetch()} />
      ) : (
        <p className="office-note">{t("office.disaggregation.act.hint")}</p>
      )}
      {/* On the screen before it is said into, so that what is put into it is heard once, by
          this region: its messages are not alerts of their own (`role="presentation"`). */}
      <div aria-live="polite">
        {stage !== null && <p className="office-note">{t(`office.forms.${stage}`)}</p>}
        {outcome?.kind === "opened" && (
          <Alert
            tone="ok"
            role="presentation"
            action={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void showFolder(outcome.saved)}
              >
                {t("office.forms.showFolder")}
              </Button>
            }
          >
            {t("office.forms.opened", { path: outcome.saved.path })}
          </Alert>
        )}
        {hostCopy !== null && (
          <Alert tone="warn" role="presentation">
            {t("office.storedFiles.hostCopyFailed", { reason: hostCopy })}
          </Alert>
        )}
        {outcome?.kind === "failed" && (
          <Alert tone="error" role="presentation">
            {outcome.message}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
