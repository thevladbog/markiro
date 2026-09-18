/**
 * Per-pallet GIS MT aggregation export (warehouse pallets, spec §4 «Export
 * dialog»): one format today, so the form is a radio with a single option
 * plus the button, and the history is the same block the shift panel shows.
 * Only a CLOSED pallet is offered the form: the server refuses an open one
 * with `PALLET_NOT_CLOSED` and a retired one with `PALLET_DISASSEMBLED`, and
 * a red row for something that could never have worked helps nobody.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, RadioGroup, Spinner } from "@markiro/ui";
import type { PalletExportFormatId } from "@markiro/domain";

import { ExportHistory, exportErrorMessage } from "../shifts/export-history.js";
import {
  useCreatePalletExport,
  usePalletExportFormats,
  usePalletExports,
} from "../shifts/shift-exports-api.js";
import type { PalletCardDto } from "./api.js";
import "../shifts/shifts.css";

export function PalletExportsSection({ pallet }: { pallet: PalletCardDto }) {
  const { t } = useTranslation();
  const closed = pallet.status === "closed";
  const formats = usePalletExportFormats();
  const exportsQuery = usePalletExports(pallet.id, true);
  const create = useCreatePalletExport();
  const idempotencyKey = useRef<string | null>(null);
  const [formatId, setFormatId] = useState<PalletExportFormatId | "">("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const firstFormat = formats.data?.[0];
    if (!firstFormat || formatId) return;
    setFormatId(firstFormat.id);
  }, [formatId, formats.data]);

  const canSubmit = closed && Boolean(formatId) && !formats.isPending && !create.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !formatId) return;
    const selectedFormat = (formats.data ?? []).find((format) => format.id === formatId);
    if (!selectedFormat) return;
    // The same key is reused across retries of one unchanged submission, so a
    // network hiccup cannot queue the export twice; editing any field resets
    // it (see onValueChange).
    const requestIdempotencyKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestIdempotencyKey;
    setError(null);
    try {
      await create.mutateAsync({
        palletId: pallet.id,
        input: {
          formatId,
          formatVersion: selectedFormat.version,
          idempotencyKey: requestIdempotencyKey,
        },
      });
      idempotencyKey.current = null;
    } catch (caught) {
      setError(exportErrorMessage(caught, t));
    }
  };

  return (
    <div className="mk-shift-exports">
      {closed ? (
        <form
          id="pallet-export-form"
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
              name="pallet-export-format"
              value={formatId}
              disabled={create.isPending}
              onValueChange={(value) => {
                idempotencyKey.current = null;
                setFormatId(value as PalletExportFormatId);
              }}
              options={(formats.data ?? []).map((format) => ({
                value: format.id,
                label: format.label,
              }))}
            />
          )}
          <Button type="submit" disabled={!canSubmit} loading={create.isPending}>
            {t("pages.codeSearch.palletCard.exports.create")}
          </Button>
        </form>
      ) : (
        <p className="mk-shift-exports__empty">
          {pallet.status === "disassembled"
            ? t("pages.codeSearch.palletCard.exports.disassembledHint")
            : t("pages.codeSearch.palletCard.exports.afterCloseHint")}
        </p>
      )}
      <ExportHistory
        items={exportsQuery.data}
        isPending={exportsQuery.isPending}
        isError={exportsQuery.isError}
        formats={formats.data ?? []}
        emptyText={t("pages.codeSearch.palletCard.exports.historyEmpty")}
        onError={(caught) => setError(exportErrorMessage(caught, t))}
      />
    </div>
  );
}
