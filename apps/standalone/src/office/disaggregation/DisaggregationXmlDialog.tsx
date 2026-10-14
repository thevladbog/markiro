import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, DefinitionGrid, Modal } from "@markiro/ui";

import {
  DISAGGREGATION_XML_FORMAT_ID,
  DISAGGREGATION_XML_FORMAT_VERSION,
  type DisaggregationExportRecord,
} from "../../host/disaggregation.js";
import { errorMessageKey } from "../../host/errors.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { OfficeFilesError, type SavedFolder } from "../exports/office-files.js";
import { paint } from "../forms/print-form.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { disaggregationXmlFolder, formDisaggregationXml } from "./disaggregation-xml.js";

export interface DisaggregationXmlDialogProps {
  documentId: string;
  docNo: string;
  /** `formTimeZone(org)`: the folder's moment is the organization's. */
  timeZone: string;
  onClose: () => void;
}

/** Where a press is. */
type Phase = "idle" | "reading" | "forming" | "saving" | "recording";

type Outcome =
  | { kind: "saved"; saved: SavedFolder; unrecorded: DisaggregationExportRecord | null }
  | { kind: "failed"; message: string };

/**
 * The ЧЗ file of an applied document (plan ДЗГ-О, owner decision ПР-2):
 * ГИС МТ «Расформирование упаковки». The dialog shows what the file will name
 * and where it goes; a press reads the document AGAIN, forms the file with
 * `@markiro/domain`'s generator, saves it under
 * `Документы\Markiro\Выгрузки\Дезагрегация` and only then asks the host to
 * write the audit row of it. A row the host refuses leaves the saved file
 * where it is and offers to write the same row again. The file is loaded
 * into the Честный знак cabinet by hand. Every office role with the
 * disaggregation right forms it (`planShifts` gates the button).
 */
export function DisaggregationXmlDialog({
  documentId,
  docNo,
  timeZone,
  onClose,
}: DisaggregationXmlDialogProps) {
  const { t } = useTranslation();
  const files = useOfficeFiles();
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const rows = useOfficeQuery(officeKeys.disaggregationReport(documentId, "boxes"), (api, token) =>
    api.getDisaggregationReportRows(token, documentId, "boxes"),
  );
  const record = useOfficeMutation((api, token, body: DisaggregationExportRecord) =>
    api.recordDisaggregationExport(token, documentId, body),
  );
  const busy = phase !== "idle";
  const reading = rows.isPending || (rows.isFetching && !busy);
  const failed = !reading && rows.isError;
  const planned = useMemo(
    () => (rows.data === undefined ? null : formDisaggregationXml(rows.data)),
    [rows.data],
  );

  function failureText(error: unknown): string {
    const code = error instanceof OfficeFilesError ? error.code : "storage";
    return t(`office.exports.files.${code}`);
  }

  /** Writes the journal's row of a file already saved; a refusal leaves the same row to write again. */
  async function writeRecord(saved: SavedFolder, body: DisaggregationExportRecord): Promise<void> {
    setPhase("recording");
    try {
      await record.mutateAsync(body);
      if (alive.current) setOutcome({ kind: "saved", saved, unrecorded: null });
    } catch {
      if (alive.current) setOutcome({ kind: "saved", saved, unrecorded: body });
    }
  }

  async function form(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setOutcome(null);
    setPhase("reading");
    try {
      const answer = await rows.refetch();
      if (answer.isError || answer.data === undefined) {
        if (alive.current) {
          setOutcome({ kind: "failed", message: t(errorMessageKey(answer.error)) });
        }
        return;
      }
      setPhase("forming");
      await paint();
      if (!alive.current) return;
      const result = formDisaggregationXml(answer.data);
      if (!result.ok) {
        setOutcome({
          kind: "failed",
          message: t(`office.disaggregation.xml.refusals.${result.refusal}`),
        });
        return;
      }
      setPhase("saving");
      let saved: SavedFolder;
      try {
        saved = await files.save(
          disaggregationXmlFolder(docNo, new Date().toISOString(), timeZone),
          [{ name: result.file.name, bytes: result.file.bytes }],
        );
      } catch (error) {
        if (alive.current) setOutcome({ kind: "failed", message: failureText(error) });
        return;
      }
      await writeRecord(saved, {
        formatId: DISAGGREGATION_XML_FORMAT_ID,
        formatVersion: DISAGGREGATION_XML_FORMAT_VERSION,
        packingCount: result.file.packingCount,
      });
    } catch {
      if (alive.current) {
        setOutcome({ kind: "failed", message: t("office.exports.failures.GENERATION_FAILED") });
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setPhase("idle");
    }
  }

  async function recordAgain(saved: SavedFolder, body: DisaggregationExportRecord): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await writeRecord(saved, body);
    } finally {
      inFlight.current = false;
      if (alive.current) setPhase("idle");
    }
  }

  async function openFolder(saved: SavedFolder): Promise<void> {
    try {
      await files.open(saved.segments);
    } catch (error) {
      if (alive.current) setOutcome({ kind: "failed", message: failureText(error) });
    }
  }

  const refusal = planned !== null && !planned.ok ? planned.refusal : null;
  const waiting = busy ? { "aria-disabled": true as const } : {};
  const content = () => {
    if (reading) return <PageLoading />;
    if (failed) return <LoadError error={rows.error} onRetry={() => void rows.refetch()} />;
    const data = rows.data;
    if (data === undefined) return null;
    return (
      <>
        <p>{t("office.disaggregation.xml.summary")}</p>
        {refusal !== null ? (
          <Alert tone="warn">{t(`office.disaggregation.xml.refusals.${refusal}`)}</Alert>
        ) : (
          <DefinitionGrid
            items={[
              {
                id: "packings",
                term: t("office.disaggregation.xml.packings"),
                description: planned !== null && planned.ok ? planned.file.packingCount : "",
              },
              {
                id: "inn",
                term: t("office.disaggregation.xml.inn"),
                description: data.organization.inn ?? "",
                mono: true,
              },
              {
                id: "folder",
                term: t("office.disaggregation.xml.folder"),
                description: `Документы\\Markiro\\Выгрузки\\Дезагрегация\\${docNo}`,
              },
            ]}
          />
        )}
        <p className="office-note">{t("office.disaggregation.xml.manual")}</p>
      </>
    );
  };

  return (
    <Modal
      open
      title={t("office.disaggregation.xml.title", { docNo })}
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={() => !inFlight.current && onClose()}>
            {t("office.common.close")}
          </Button>
          {!reading && !failed && refusal === null && (
            <Button {...waiting} onClick={() => void form()}>
              {t("office.disaggregation.xml.submit")}
            </Button>
          )}
        </>
      }
    >
      {content()}
      <div aria-live="polite">
        {phase !== "idle" && (
          <p className="office-note">{t(`office.disaggregation.xml.${phase}`)}</p>
        )}
        {outcome?.kind === "saved" && (
          <>
            <Alert
              tone="ok"
              role="presentation"
              action={
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => void openFolder(outcome.saved)}
                >
                  {t("office.disaggregation.xml.showFolder")}
                </Button>
              }
            >
              {t("office.disaggregation.xml.saved", { path: outcome.saved.path })}
            </Alert>
            {outcome.unrecorded !== null && (
              <Alert
                tone="warn"
                action={
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={busy}
                    onClick={() => {
                      if (outcome.unrecorded !== null) {
                        void recordAgain(outcome.saved, outcome.unrecorded);
                      }
                    }}
                  >
                    {t("office.disaggregation.xml.recordAgain")}
                  </Button>
                }
              >
                {t("office.disaggregation.xml.recordFailed")}
              </Alert>
            )}
          </>
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
