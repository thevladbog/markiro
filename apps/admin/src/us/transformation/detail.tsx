import { useCallback, useState } from "react";
import type { TransformationHttpRecord } from "@markiro/platform-contracts";
import { Button, StatusChip } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { UsBrowserClient } from "../client.js";
import { LotCasesPanel } from "./cases.js";
import { TransformationGenealogyPanel } from "./genealogy.js";

function civilDate(value: string, language: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value}T12:00:00Z`),
  );
}

function instant(value: string, language: string, timeZone: string) {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

export function TransformationDetail({
  record,
  onOpenLot,
  onOpenRevision,
  navigationDisabled = false,
  evidence,
}: {
  record: TransformationHttpRecord;
  onOpenLot: (id: string) => void;
  onOpenRevision: (id: string) => void;
  navigationDisabled?: boolean;
  evidence?: {
    client: UsBrowserClient;
    canWriteCases: boolean;
    beginMutation: () => () => void;
    onForbidden: () => Promise<void>;
    onSessionLost: () => void;
    onProtectedChange: (protectedState: boolean) => void;
  };
}) {
  const { t, i18n } = useTranslation();
  const frozen = "snapshot" in record ? record.snapshot : null;
  const saved = "draft" in record ? record.draft : null;
  const lifecycle = record.lifecycle;
  const evidenceVersion = `${record.id}/${lifecycle?.lifecycleVersion ?? record.draftVersion}/${record.status}`;
  const predecessorId = lifecycle?.previousRevisionId;
  const successorId = lifecycle?.supersededByEventId;
  const eventDate = frozen?.eventDate ?? saved?.eventDate;
  const timeZone = frozen?.timeZone ?? record.timeZone;
  const quantity = (value: string | null, unit: string | null) => `${value ?? "—"} ${unit ?? "—"}`;
  const status = t(`events.${record.status}`);
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [caseProtected, setCaseProtected] = useState(false);
  const selectedOutput =
    frozen?.outputs.find((row) => row.lotId === selectedLotId) ?? frozen?.outputs[0];
  const onEvidenceProtectedChange = evidence?.onProtectedChange;
  const protectCases = useCallback(
    (protectedState: boolean) => {
      setCaseProtected(protectedState);
      onEvidenceProtectedChange?.(protectedState);
    },
    [onEvidenceProtectedChange],
  );
  return (
    <article className="us-tr-detail" aria-label={t("transformation.detail.title")}>
      <header className="us-tr-detail__header">
        <StatusChip status={record.status === "finalized" ? "ok" : "neutral"} label={status} />
        <span>
          {status} · {t("transformation.detail.revision")} {record.revision}
        </span>
        {lifecycle?.currentEventId === record.id ? (
          <strong>{t("transformation.detail.current")}</strong>
        ) : null}
        {lifecycle?.pendingDraftId === record.id ? (
          <strong>{t("transformation.detail.pending")}</strong>
        ) : null}
      </header>
      <dl className="us-tr-detail__facts">
        <div>
          <dt>{t("events.date")}</dt>
          <dd>
            {eventDate ? civilDate(eventDate, i18n.language) : "—"} ·{" "}
            <span className="us-tr-mono">{timeZone}</span>
          </dd>
        </div>
        <div>
          <dt>{t("transformation.processor")}</dt>
          <dd>{frozen?.processor.description ?? saved?.processorLocationId ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("transformation.reason")}</dt>
          <dd>
            {(frozen?.reason ?? saved?.reason)
              ? t(`transformation.${frozen?.reason ?? saved?.reason}`)
              : "—"}
          </dd>
        </div>
        {(frozen?.reasonNote ?? saved?.reasonNote) ? (
          <div>
            <dt>{t("transformation.reasonNote")}</dt>
            <dd>{frozen?.reasonNote ?? saved?.reasonNote}</dd>
          </div>
        ) : null}
        {(frozen?.notes ?? saved?.notes) ? (
          <div>
            <dt>{t("transformation.notes")}</dt>
            <dd>{frozen?.notes ?? saved?.notes}</dd>
          </div>
        ) : null}
      </dl>
      {frozen ? (
        <>
          <section className="us-tr-section" aria-label={t("transformation.inputs")}>
            <h2>{t("transformation.inputs")}</h2>
            <ol className="us-tr-detail__lines">
              {frozen.inputs.map((row) => (
                <li key={row.lineNo} tabIndex={-1} data-readiness-line={`inputs:${row.lineNo}`}>
                  <span>{row.product.description}</span>
                  {row.kind === "ftl_lot" ? (
                    <span className="us-tr-mono">
                      {row.tlc} · {row.lotId}
                    </span>
                  ) : (
                    <span>{row.reference}</span>
                  )}
                  <span>{row.source.description}</span>
                  <span className="us-tr-mono">{row.source.id}</span>
                  {row.source.kind === "reference" ? (
                    <span className="us-tr-mono">{row.source.referenceValue}</span>
                  ) : null}
                  <strong className="us-tr-mono">
                    {quantity(row.quantity, row.unitOfMeasure)}
                  </strong>
                </li>
              ))}
            </ol>
          </section>
          <section className="us-tr-section" aria-label={t("transformation.outputs")}>
            <h2>{t("transformation.outputs")}</h2>
            <ol className="us-tr-detail__lines">
              {frozen.outputs.map((row) => (
                <li key={row.lotId} tabIndex={-1} data-readiness-line={`outputs:${row.lineNo}`}>
                  <span>{row.product.description}</span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    disabled={navigationDisabled}
                    onClick={() => onOpenLot(row.lotId)}
                  >
                    {row.tlc}
                  </Button>
                  <span className="us-tr-mono">{row.lotId}</span>
                  <span>{row.source.description}</span>
                  <span className="us-tr-mono">{row.source.id}</span>
                  <strong className="us-tr-mono">
                    {quantity(row.quantity, row.unitOfMeasure)}
                  </strong>
                </li>
              ))}
            </ol>
          </section>
          <section className="us-tr-section" aria-label={t("transformation.documents")}>
            <h2>{t("transformation.documents")}</h2>
            <ul className="us-tr-detail__lines">
              {frozen.documents.map((row) => (
                <li key={row.id}>
                  <span>{row.type}</span>
                  <strong>{row.number}</strong>
                  <span className="us-tr-mono">{row.id}</span>
                </li>
              ))}
            </ul>
          </section>
          <p className="us-tr-hint">
            {t("transformation.detail.finalizedBy")}: {frozen.finalizedBy} ·{" "}
            {instant(frozen.finalizedAt, i18n.language, timeZone)} {timeZone}
          </p>
          {evidence && selectedOutput ? (
            <>
              {frozen.outputs.length > 1 ? (
                <div className="us-tr-actions" aria-label={t("transformation.cases.chooseOutput")}>
                  {frozen.outputs.map((row) => (
                    <Button
                      key={row.lotId}
                      type="button"
                      variant={row.lotId === selectedOutput.lotId ? "primary" : "secondary"}
                      disabled={navigationDisabled || caseProtected}
                      onClick={() => setSelectedLotId(row.lotId)}
                    >
                      {row.tlc}
                    </Button>
                  ))}
                </div>
              ) : null}
              <p className="us-tr-hint">
                {t("transformation.cases.outputLot", { tlc: selectedOutput.tlc })}
              </p>
              <LotCasesPanel
                key={`${selectedOutput.lotId}/cases`}
                client={evidence.client}
                lotId={selectedOutput.lotId}
                evidenceVersion={evidenceVersion}
                canWrite={evidence.canWriteCases}
                disabled={navigationDisabled}
                timeZone={timeZone}
                beginMutation={evidence.beginMutation}
                onForbidden={evidence.onForbidden}
                onSessionLost={evidence.onSessionLost}
                onProtectedChange={protectCases}
              />
              <TransformationGenealogyPanel
                key={`${selectedOutput.lotId}/genealogy`}
                client={evidence.client}
                lotId={selectedOutput.lotId}
                evidenceVersion={evidenceVersion}
                pinnedRevisionId={record.id}
                disabled={navigationDisabled}
                onForbidden={evidence.onForbidden}
                onSessionLost={evidence.onSessionLost}
              />
            </>
          ) : null}
        </>
      ) : saved ? (
        <>
          <p className="us-tr-notice">{t("transformation.detail.noSnapshot")}</p>
          <section className="us-tr-section" aria-label={t("transformation.inputs")}>
            <h2>{t("transformation.inputs")}</h2>
            <ol className="us-tr-detail__lines">
              {saved.inputs.map((row, index) => (
                <li key={index} tabIndex={-1} data-readiness-line={`inputs:${index + 1}`}>
                  <span className="us-tr-mono">
                    {row.kind === "ftl_lot" ? row.lotId : row.productId}
                  </span>
                  {row.kind === "non_ftl" ? <span>{row.reference}</span> : null}
                  <strong className="us-tr-mono">
                    {quantity(row.quantity, row.unitOfMeasure)}
                  </strong>
                </li>
              ))}
            </ol>
          </section>
          <section className="us-tr-section" aria-label={t("transformation.outputs")}>
            <h2>{t("transformation.outputs")}</h2>
            <ol className="us-tr-detail__lines">
              {saved.outputs.map((row, index) => (
                <li key={index} tabIndex={-1} data-readiness-line={`outputs:${index + 1}`}>
                  <span className="us-tr-mono">{row.tlc}</span>
                  <span className="us-tr-mono">{row.productId}</span>
                  <strong className="us-tr-mono">
                    {quantity(row.quantity, row.unitOfMeasure)}
                  </strong>
                </li>
              ))}
            </ol>
          </section>
          <section className="us-tr-section" aria-label={t("transformation.documents")}>
            <h2>{t("transformation.documents")}</h2>
            <ul className="us-tr-detail__lines">
              {saved.documentIds.map((id) => (
                <li className="us-tr-mono" key={id}>
                  {id}
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
      {lifecycle ? (
        <section className="us-tr-section" aria-label={t("transformation.detail.provenance")}>
          <h2>{t("transformation.detail.provenance")}</h2>
          <dl className="us-tr-detail__facts">
            <div>
              <dt>{t("transformation.detail.root")}</dt>
              <dd className="us-tr-mono">{lifecycle.rootId}</dd>
            </div>
            <div>
              <dt>{t("transformation.detail.current")}</dt>
              <dd className="us-tr-mono">{lifecycle.currentEventId ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("transformation.detail.pending")}</dt>
              <dd className="us-tr-mono">{lifecycle.pendingDraftId ?? "—"}</dd>
            </div>
            {predecessorId ? (
              <div>
                <dt>{t("transformation.detail.predecessor")}</dt>
                <dd>
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    onClick={() => onOpenRevision(predecessorId)}
                  >
                    {predecessorId}
                  </Button>
                </dd>
              </div>
            ) : null}
            {lifecycle.amendmentReason ? (
              <div>
                <dt>{t("transformation.detail.amendmentReason")}</dt>
                <dd>{lifecycle.amendmentReason}</dd>
              </div>
            ) : null}
            {successorId ? (
              <div>
                <dt>{t("transformation.detail.successor")}</dt>
                <dd>
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    onClick={() => onOpenRevision(successorId)}
                  >
                    {t("transformation.detail.successor")} · {successorId}
                  </Button>
                </dd>
              </div>
            ) : null}
            {lifecycle.voidReason ? (
              <div>
                <dt>{t("transformation.detail.voidReason")}</dt>
                <dd>{lifecycle.voidReason}</dd>
              </div>
            ) : null}
            {lifecycle.voidedBy ? (
              <div>
                <dt>{t("transformation.detail.voidedBy")}</dt>
                <dd>{lifecycle.voidedBy}</dd>
              </div>
            ) : null}
            {lifecycle.voidedAt ? (
              <div>
                <dt>{t("transformation.detail.voidedAt")}</dt>
                <dd>
                  {instant(lifecycle.voidedAt, i18n.language, timeZone)} {timeZone}
                </dd>
              </div>
            ) : null}
          </dl>
          {record.status === "void" ? (
            <p className="us-tr-notice">{t("transformation.detail.excluded")}</p>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}
