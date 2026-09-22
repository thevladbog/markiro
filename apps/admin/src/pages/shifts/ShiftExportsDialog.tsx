import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, Modal, RadioGroup, Spinner } from "@markiro/ui";

import { shiftExportFormatRequiresPallets, type ShiftExportFormatId } from "@markiro/domain";

import type { ShiftDto } from "./api.js";
import { ExportHistory, exportErrorMessage } from "./export-history.js";
import {
  useCreateShiftExport,
  useShiftExportFormats,
  useShiftExports,
} from "./shift-exports-api.js";

export interface ShiftExportsDialogProps {
  shift: ShiftDto;
  open: boolean;
  onClose: () => void;
}

export interface ShiftExportsContentProps {
  shift: ShiftDto;
  enabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

const MIN_LINES_PER_PART = 2;
const MAX_LINES_PER_PART = 1_000_000;
const DEFAULT_LINES_PER_PART = 2_000;

function parseLineLimit(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_LINES_PER_PART && parsed <= MAX_LINES_PER_PART
    ? parsed
    : null;
}

export function ShiftExportsContent({
  shift,
  enabled = true,
  onBusyChange,
}: ShiftExportsContentProps) {
  const { t } = useTranslation();
  const formats = useShiftExportFormats();
  const exportsQuery = useShiftExports(shift.id, enabled);
  const create = useCreateShiftExport();
  const idempotencyKey = useRef<string | null>(null);
  const [formatId, setFormatId] = useState<ShiftExportFormatId | "">("");
  const [split, setSplit] = useState(false);
  const [lineLimit, setLineLimit] = useState(String(DEFAULT_LINES_PER_PART));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onBusyChange?.(create.isPending);
  }, [create.isPending, onBusyChange]);

  /**
   * `GET /shift-exports/formats` advertises every format unfiltered -- the
   * server has no shift in hand there. A pallet format ordered for a shift
   * that never stacked pallets does not fail fast: it is accepted, queued,
   * and only then fails asynchronously with `SHIFT_HAS_NO_PALLETS`, leaving a
   * red row in the history for something that could never have worked. So the
   * pallet-gated formats (`shiftExportFormatRequiresPallets`) are offered only for a shift that
   * switched pallets on.
   */
  const offeredFormats = useMemo(
    () =>
      (formats.data ?? []).filter(
        (format) => shift.palletsEnabled || !shiftExportFormatRequiresPallets(format),
      ),
    [formats.data, shift.palletsEnabled],
  );

  useEffect(() => {
    const firstFormat = offeredFormats[0];
    if (!firstFormat || formatId) return;
    setFormatId(firstFormat.id);
  }, [formatId, offeredFormats]);

  const parsedLineLimit = split ? parseLineLimit(lineLimit) : null;
  const lineLimitError =
    split && parsedLineLimit === null ? t("pages.shifts.exports.validation.lineLimit") : undefined;
  const canSubmit = Boolean(formatId) && !formats.isPending && !create.isPending && !lineLimitError;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !formatId) return;
    const selectedFormat = offeredFormats.find((format) => format.id === formatId);
    if (!selectedFormat) return;
    // The same key is reused across retries of one unchanged submission, so a
    // network hiccup cannot queue the export twice; editing any field resets
    // it (see onValueChange).
    const requestIdempotencyKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestIdempotencyKey;
    setError(null);
    try {
      await create.mutateAsync({
        shiftId: shift.id,
        input: {
          formatId,
          formatVersion: selectedFormat.version,
          maxLines: parsedLineLimit,
          idempotencyKey: requestIdempotencyKey,
        },
      });
      idempotencyKey.current = null;
      setSplit(false);
      setLineLimit(String(DEFAULT_LINES_PER_PART));
    } catch (caught) {
      setError(exportErrorMessage(caught, t));
    }
  };

  return (
    <div className="mk-shift-exports">
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
            options={offeredFormats.map((format) => ({
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
        <Button type="submit" disabled={!canSubmit} loading={create.isPending}>
          {t("pages.shifts.exports.create")}
        </Button>
      </form>
      <ExportHistory
        items={exportsQuery.data}
        isPending={exportsQuery.isPending}
        isError={exportsQuery.isError}
        formats={formats.data ?? []}
        emptyText={t("pages.shifts.exports.historyEmpty")}
        onError={(caught) => setError(exportErrorMessage(caught, t))}
      />
    </div>
  );
}

export function ShiftExportsDialog({ shift, open, onClose }: ShiftExportsDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open={open}
      title={t("pages.shifts.exports.title")}
      closeLabel={t("common.close")}
      {...(busy ? {} : { onClose })}
      width="min(760px, calc(100vw - 32px))"
      className="mk-shift-exports-modal"
      footer={
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
          {t("pages.shifts.cancel")}
        </Button>
      }
    >
      <ShiftExportsContent shift={shift} enabled={open} onBusyChange={setBusy} />
    </Modal>
  );
}
