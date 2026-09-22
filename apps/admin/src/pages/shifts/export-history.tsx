/**
 * The export history UI shared by the shift panel/dialog and the pallet card:
 * one row per export with status, parameters, failure text with retry, and
 * the downloadable parts. Both scopes produce the same `ShiftExportDto`
 * rows and the same `pages.shifts.exports.*` wording, so this is one module,
 * not two copies.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner, StatusChip } from "@markiro/ui";
import type { TagPhase } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  downloadShiftExportArtifact,
  useRetryShiftExport,
  type ShiftExportArtifactDto,
  type ShiftExportDto,
  type ShiftExportStatus,
} from "./shift-exports-api.js";

export const EXPORT_STATUS_TO_PHASE: Record<ShiftExportStatus, TagPhase> = {
  queued: "planned",
  processing: "running",
  ready: "done",
  failed: "failed",
};

/**
 * Mirrors `SHIFT_EXPORT_SAFE_ERROR_CODES`
 * (apps/api/src/modules/shift-exports/shift-export-runner.service.ts). A code
 * missing here is not a cosmetic gap: the UI falls back to the generic
 * infrastructure sentence and the operator never learns what actually went
 * wrong. Keep the two lists in step.
 */
export const EXPORT_SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
  "SHIFT_NOT_CLOSED",
  "SHIFT_HAS_NO_CODES",
  "SHIFT_DATE_MISSING",
  "BOX_COVERAGE_INCOMPLETE",
  "SHIFT_HAS_NO_PALLETS",
  "PALLET_NOT_CLOSED",
  "PALLET_DISASSEMBLED",
  "ORG_INN_MISSING",
  "ORG_NAME_MISSING",
  "INVALID_ORG_INN",
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
  "BOX_EXCEEDS_LINE_LIMIT",
  "PALLET_EXCEEDS_LINE_LIMIT",
  "INVALID_BOX_SSCC",
  "INVALID_CIS",
  "GENERATION_FAILED",
  "STORAGE_FAILED",
  "QUEUE_FAILED",
]);

export function formatExportNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(value);
}

export function formatExportDateTime(value: string | null, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function exportErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiRequestError && error.code && EXPORT_SAFE_ERROR_CODES.has(error.code)) {
    return t(`pages.shifts.exports.errors.${error.code}`);
  }
  return t("pages.shifts.exports.errors.infrastructure");
}

function ExportParameters({
  item,
  language,
  formatLabel,
}: {
  item: ShiftExportDto;
  language: string;
  formatLabel: string | undefined;
}) {
  const { t } = useTranslation();
  const split =
    item.maxLines === null
      ? t("pages.shifts.exports.parameters.single")
      : t("pages.shifts.exports.parameters.split", {
          count: formatExportNumber(item.maxLines, language),
        });

  return (
    <dl className="mk-shift-exports__details">
      <div>
        <dt>{t("pages.shifts.exports.details.actor")}</dt>
        <dd>{item.createdByName ?? t("pages.shifts.exports.details.unknownActor")}</dd>
      </div>
      <div>
        <dt>{t("pages.shifts.exports.details.created")}</dt>
        <dd>{formatExportDateTime(item.createdAt, language) ?? "—"}</dd>
      </div>
      <div>
        <dt>{t("pages.shifts.exports.details.format")}</dt>
        <dd>{formatLabel ?? item.formatId}</dd>
      </div>
      <div>
        <dt>{t("pages.shifts.exports.details.parameters")}</dt>
        <dd>{split}</dd>
      </div>
      {item.totalCodeCount !== null ? (
        <div>
          <dt>{t("pages.shifts.exports.details.codes")}</dt>
          <dd>
            {t("pages.shifts.exports.counts.codes", {
              count: formatExportNumber(item.totalCodeCount, language),
            })}
          </dd>
        </div>
      ) : null}
      {item.totalBoxCount !== null && item.totalBoxCount > 0 ? (
        <div>
          <dt>{t("pages.shifts.exports.details.boxes")}</dt>
          <dd>
            {t("pages.shifts.exports.counts.boxes", {
              count: formatExportNumber(item.totalBoxCount, language),
            })}
          </dd>
        </div>
      ) : null}
      {item.totalPalletCount !== null && item.totalPalletCount > 0 ? (
        <div>
          <dt>{t("pages.shifts.exports.details.pallets")}</dt>
          <dd>
            {t("pages.shifts.exports.counts.pallets", {
              count: formatExportNumber(item.totalPalletCount, language),
            })}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function ArtifactRow({
  item,
  artifact,
  language,
  onError,
}: {
  item: ShiftExportDto;
  artifact: ShiftExportArtifactDto;
  language: string;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const result = await downloadShiftExportArtifact(item.id, artifact.id);
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } catch (error) {
      onError(error);
    } finally {
      setDownloading(false);
    }
  };

  const counts = [
    t("pages.shifts.exports.counts.lines", {
      count: formatExportNumber(artifact.physicalLineCount, language),
    }),
    t("pages.shifts.exports.counts.codes", {
      count: formatExportNumber(artifact.codeCount, language),
    }),
    ...(artifact.boxCount > 0
      ? [
          t("pages.shifts.exports.counts.boxes", {
            count: formatExportNumber(artifact.boxCount, language),
          }),
        ]
      : []),
    ...(artifact.palletCount > 0
      ? [
          t("pages.shifts.exports.counts.pallets", {
            count: formatExportNumber(artifact.palletCount, language),
          }),
        ]
      : []),
    t("pages.shifts.exports.counts.bytes", {
      count: formatExportNumber(artifact.byteSize, language),
    }),
  ];

  return (
    <li className="mk-shift-exports__part">
      <div>
        <strong>{t("pages.shifts.exports.part", { number: artifact.partNumber })}</strong>
        <span>{counts.join(" · ")}</span>
        <span className="mk-shift-exports__filename">{artifact.filename}</span>
      </div>
      <Button
        type="button"
        size="compact"
        variant="secondary"
        loading={downloading}
        onClick={() => void download()}
      >
        {t("pages.shifts.exports.download")}
      </Button>
    </li>
  );
}

export function HistoryRow({
  item,
  language,
  formatLabel,
  onError,
}: {
  item: ShiftExportDto;
  language: string;
  formatLabel: string | undefined;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const retry = useRetryShiftExport();
  const [retryError, setRetryError] = useState<string | null>(null);

  const retryExport = async () => {
    setRetryError(null);
    try {
      await retry.mutateAsync({
        exportId: item.id,
        shiftId: item.shiftId,
        palletId: item.palletId,
      });
    } catch (error) {
      setRetryError(exportErrorMessage(error, t));
    }
  };

  return (
    <article className="mk-shift-exports__history-row">
      <div className="mk-shift-exports__history-head">
        <StatusChip
          phase={EXPORT_STATUS_TO_PHASE[item.status]}
          label={t(`pages.shifts.exports.status.${item.status}`)}
        />
        <span>{formatExportDateTime(item.completedAt ?? item.createdAt, language) ?? "—"}</span>
      </div>
      {item.stale ? <Alert tone="warn">{t("pages.shifts.exports.stale")}</Alert> : null}
      <ExportParameters item={item} language={language} formatLabel={formatLabel} />
      {item.status === "failed" ? (
        <div className="mk-shift-exports__failed">
          <Alert tone="error">
            {item.errorCode && EXPORT_SAFE_ERROR_CODES.has(item.errorCode)
              ? t(`pages.shifts.exports.errors.${item.errorCode}`)
              : t("pages.shifts.exports.errors.infrastructure")}
          </Alert>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            loading={retry.isPending}
            onClick={() => void retryExport()}
          >
            {t("pages.shifts.exports.retry")}
          </Button>
          {retryError ? <Alert tone="error">{retryError}</Alert> : null}
        </div>
      ) : null}
      {item.status === "ready" && item.artifacts.length > 0 ? (
        <ol className="mk-shift-exports__parts">
          {[...item.artifacts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((artifact) => (
              <ArtifactRow
                key={artifact.id}
                item={item}
                artifact={artifact}
                language={language}
                onError={onError}
              />
            ))}
        </ol>
      ) : null}
    </article>
  );
}

/**
 * The history block: newest first, with format labels resolved by
 * `id@version` first and by `id` alone as a fallback (a row from a version no
 * longer advertised still gets its friendly label).
 */
export function ExportHistory({
  items,
  isPending,
  isError,
  formats,
  emptyText,
  onError,
}: {
  items: ShiftExportDto[] | undefined;
  isPending: boolean;
  isError: boolean;
  formats: readonly { id: string; version: number; label: string }[];
  emptyText: string;
  onError: (error: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const history = [...(items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const formatLabels = new Map(
    formats.map((format) => [`${format.id}@${format.version}`, format.label]),
  );
  const formatLabelsById = new Map(formats.map((format) => [format.id, format.label]));

  return (
    <section
      className="mk-shift-exports__history"
      aria-label={t("pages.shifts.exports.historyLabel")}
    >
      <h3>{t("pages.shifts.exports.historyTitle")}</h3>
      {isPending ? <Spinner label={t("common.loading")} /> : null}
      {isError ? (
        <Alert tone="error">{t("pages.shifts.exports.errors.infrastructure")}</Alert>
      ) : null}
      {!isPending && !isError && history.length === 0 ? (
        <p className="mk-shift-exports__empty">{emptyText}</p>
      ) : null}
      {history.map((item) => (
        <HistoryRow
          key={item.id}
          item={item}
          language={i18n.language}
          formatLabel={
            formatLabels.get(`${item.formatId}@${item.formatVersion}`) ??
            formatLabelsById.get(item.formatId)
          }
          onError={onError}
        />
      ))}
    </section>
  );
}
