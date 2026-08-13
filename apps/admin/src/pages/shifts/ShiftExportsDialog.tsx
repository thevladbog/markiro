import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  RadioGroup,
  Spinner,
  StatusChip,
} from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import type { ShiftExportFormatId } from "@markiro/domain";

import { ApiRequestError } from "../../api/client.js";
import type { ShiftDto } from "./api.js";
import {
  downloadShiftExportArtifact,
  useCreateShiftExport,
  useRetryShiftExport,
  useShiftExportFormats,
  useShiftExports,
  type ShiftExportArtifactDto,
  type ShiftExportDto,
  type ShiftExportStatus,
} from "./shift-exports-api.js";

export interface ShiftExportsDialogProps {
  shift: ShiftDto;
  open: boolean;
  onClose: () => void;
}

const MIN_LINES_PER_PART = 2;
const MAX_LINES_PER_PART = 1_000_000;
const DEFAULT_LINES_PER_PART = 2_000;

const STATUS_TO_CHIP: Record<ShiftExportStatus, StatusChipStatus> = {
  queued: "info",
  processing: "warn",
  ready: "ok",
  failed: "error",
};

const SAFE_ERROR_CODES = new Set([
  "SHIFT_NOT_CLOSED",
  "SHIFT_HAS_NO_CODES",
  "SHIFT_DATE_MISSING",
  "BOX_COVERAGE_INCOMPLETE",
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
  "BOX_EXCEEDS_LINE_LIMIT",
  "GENERATION_FAILED",
  "STORAGE_FAILED",
  "QUEUE_FAILED",
]);

function parseLineLimit(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_LINES_PER_PART && parsed <= MAX_LINES_PER_PART
    ? parsed
    : null;
}

function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(value);
}

function formatDateTime(value: string | null, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function errorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiRequestError && error.code && SAFE_ERROR_CODES.has(error.code)) {
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
          count: formatNumber(item.maxLines, language),
        });

  return (
    <dl className="mk-shift-exports__details">
      <div>
        <dt>{t("pages.shifts.exports.details.actor")}</dt>
        <dd>{item.createdByName ?? t("pages.shifts.exports.details.unknownActor")}</dd>
      </div>
      <div>
        <dt>{t("pages.shifts.exports.details.created")}</dt>
        <dd>{formatDateTime(item.createdAt, language) ?? "—"}</dd>
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
              count: formatNumber(item.totalCodeCount, language),
            })}
          </dd>
        </div>
      ) : null}
      {item.totalBoxCount !== null && item.totalBoxCount > 0 ? (
        <div>
          <dt>{t("pages.shifts.exports.details.boxes")}</dt>
          <dd>
            {t("pages.shifts.exports.counts.boxes", {
              count: formatNumber(item.totalBoxCount, language),
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
      count: formatNumber(artifact.physicalLineCount, language),
    }),
    t("pages.shifts.exports.counts.codes", { count: formatNumber(artifact.codeCount, language) }),
    ...(artifact.boxCount > 0
      ? [
          t("pages.shifts.exports.counts.boxes", {
            count: formatNumber(artifact.boxCount, language),
          }),
        ]
      : []),
    t("pages.shifts.exports.counts.bytes", { count: formatNumber(artifact.byteSize, language) }),
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

function HistoryRow({
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
      await retry.mutateAsync({ shiftId: item.shiftId, exportId: item.id });
    } catch (error) {
      setRetryError(errorMessage(error, t));
    }
  };

  return (
    <article className="mk-shift-exports__history-row">
      <div className="mk-shift-exports__history-head">
        <StatusChip
          status={STATUS_TO_CHIP[item.status]}
          label={t(`pages.shifts.exports.status.${item.status}`)}
        />
        <span>{formatDateTime(item.completedAt ?? item.createdAt, language) ?? "—"}</span>
      </div>
      {item.stale ? <Alert tone="warn">{t("pages.shifts.exports.stale")}</Alert> : null}
      <ExportParameters item={item} language={language} formatLabel={formatLabel} />
      {item.status === "failed" ? (
        <div className="mk-shift-exports__failed">
          <Alert tone="error">
            {item.errorCode && SAFE_ERROR_CODES.has(item.errorCode)
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

export function ShiftExportsDialog({ shift, open, onClose }: ShiftExportsDialogProps) {
  const { t, i18n } = useTranslation();
  const formats = useShiftExportFormats();
  const exportsQuery = useShiftExports(shift.id, open);
  const create = useCreateShiftExport();
  const idempotencyKey = useRef<string | null>(null);
  const [formatId, setFormatId] = useState<ShiftExportFormatId | "">("");
  const [split, setSplit] = useState(false);
  const [lineLimit, setLineLimit] = useState(String(DEFAULT_LINES_PER_PART));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const firstFormat = formats.data?.[0];
    if (!firstFormat || formatId) return;
    setFormatId(firstFormat.id);
  }, [formatId, formats.data]);

  const parsedLineLimit = split ? parseLineLimit(lineLimit) : null;
  const lineLimitError =
    split && parsedLineLimit === null ? t("pages.shifts.exports.validation.lineLimit") : undefined;
  const canSubmit = Boolean(formatId) && !formats.isPending && !create.isPending && !lineLimitError;
  const history = useMemo(
    () => [...(exportsQuery.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [exportsQuery.data],
  );
  const formatLabels = useMemo(
    () =>
      new Map(
        (formats.data ?? []).map((format) => [`${format.id}@${format.version}`, format.label]),
      ),
    [formats.data],
  );

  const close = () => {
    if (create.isPending) return;
    setError(null);
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !formatId) return;
    // A new deliberate submission after a failed request starts a new idempotency scope.
    const requestIdempotencyKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestIdempotencyKey;
    setError(null);
    try {
      await create.mutateAsync({
        shiftId: shift.id,
        input: {
          formatId,
          formatVersion: 1,
          maxLines: parsedLineLimit,
          idempotencyKey: requestIdempotencyKey,
        },
      });
      idempotencyKey.current = null;
      setSplit(false);
      setLineLimit(String(DEFAULT_LINES_PER_PART));
    } catch (caught) {
      setError(errorMessage(caught, t));
    }
  };

  return (
    <Modal
      open={open}
      title={t("pages.shifts.exports.title")}
      closeLabel={t("common.close")}
      {...(create.isPending ? {} : { onClose: close })}
      width="min(760px, calc(100vw - 32px))"
      className="mk-shift-exports"
      footer={
        <>
          <Button type="button" variant="secondary" disabled={create.isPending} onClick={close}>
            {t("pages.shifts.cancel")}
          </Button>
          <Button
            type="submit"
            form="shift-export-form"
            disabled={!canSubmit}
            loading={create.isPending}
          >
            {t("pages.shifts.exports.create")}
          </Button>
        </>
      }
    >
      <form
        id="shift-export-form"
        className="mk-shift-exports__form"
        onSubmit={(event) => void submit(event)}
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        {formats.isError ? (
          <Alert tone="error">{t("pages.shifts.exports.errors.infrastructure")}</Alert>
        ) : null}
        {formats.isPending ? (
          <Spinner label={t("common.loading")} />
        ) : (
          <RadioGroup
            label={t("pages.shifts.exports.formatLabel")}
            name="shift-export-format"
            value={formatId}
            disabled={create.isPending}
            onValueChange={(value) => {
              idempotencyKey.current = null;
              setFormatId(value as ShiftExportFormatId);
            }}
            options={(formats.data ?? []).map((format) => ({
              value: format.id,
              label: format.label,
            }))}
          />
        )}
        <Checkbox
          label={t("pages.shifts.exports.splitLabel")}
          checked={split}
          disabled={create.isPending}
          onCheckedChange={(value) => {
            idempotencyKey.current = null;
            setSplit(value);
          }}
        />
        {split ? (
          <Input
            required
            label={t("pages.shifts.exports.lineLimitLabel")}
            type="number"
            inputMode="numeric"
            min={MIN_LINES_PER_PART}
            max={MAX_LINES_PER_PART}
            step={1}
            value={lineLimit}
            {...(lineLimitError ? { error: lineLimitError } : {})}
            disabled={create.isPending}
            onChange={(event) => {
              idempotencyKey.current = null;
              setLineLimit(event.target.value);
            }}
          />
        ) : null}
      </form>
      <section
        className="mk-shift-exports__history"
        aria-label={t("pages.shifts.exports.historyLabel")}
      >
        <h3>{t("pages.shifts.exports.historyTitle")}</h3>
        {exportsQuery.isPending ? <Spinner label={t("common.loading")} /> : null}
        {exportsQuery.isError ? (
          <Alert tone="error">{t("pages.shifts.exports.errors.infrastructure")}</Alert>
        ) : null}
        {!exportsQuery.isPending && !exportsQuery.isError && history.length === 0 ? (
          <p className="mk-shift-exports__empty">{t("pages.shifts.exports.historyEmpty")}</p>
        ) : null}
        {history.map((item) => (
          <HistoryRow
            key={item.id}
            item={item}
            language={i18n.language}
            formatLabel={formatLabels.get(`${item.formatId}@${item.formatVersion}`)}
            onError={(caught) => setError(errorMessage(caught, t))}
          />
        ))}
      </section>
    </Modal>
  );
}
