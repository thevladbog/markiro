import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import {
  makePalletRenderingV2,
  type PalletLabelSourceV1,
  type PalletTemplateChoice,
  type PalletTemplateCatalogV2,
} from "@markiro/domain";
import type { PrinterProfile } from "../../lib/printer-routing.js";
import {
  originalPalletTemplate,
  palletTemplateUnavailable,
  previewPalletRendering,
} from "../../lib/warehouse-reprint/pallet-rendering.js";
import { LabelRasterPreview } from "../LabelRasterPreview.js";
export function PalletTemplatePicker({
  source,
  catalog,
  choice,
  profile,
  busy,
  onClose,
  onApply,
  onRefresh,
  error,
}: {
  source: PalletLabelSourceV1;
  catalog: PalletTemplateCatalogV2 | null;
  choice: PalletTemplateChoice | null;
  profile: PrinterProfile | null;
  busy: boolean;
  onClose: () => void;
  onApply: (choice: PalletTemplateChoice) => void;
  onRefresh?: () => void;
  error?: string | null;
}) {
  const { t } = useTranslation(),
    original = { ...originalPalletTemplate(source), name: t("warehouse.pallet.original") };
  const [selected, setSelected] = useState(choice ?? original),
    [preview, setPreview] = useState<Uint8Array | null>(null),
    [failed, setFailed] = useState(false);
  const choices = [
      original,
      ...(catalog?.templates ?? []).filter((c) => c.kind === source.rendering.kind),
    ],
    unavailable = palletTemplateUnavailable(source, selected, profile);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setFailed(false);
    void previewPalletRendering(
      makePalletRenderingV2(source, selected).rendering,
      profile?.dpi ?? null,
    )
      .then((bytes) => {
        if (active) setPreview(bytes);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [source, selected, profile?.dpi]);
  return (
    <FullScreenDialog
      open
      title={t("warehouse.pallet.templateTitle")}
      onClose={onClose}
      backLabel={t("warehouse.cancel")}
      backDisabled={busy}
      className="warehouse-template-dialog"
      footer={
        <Button
          size="floor"
          disabled={busy || Boolean(unavailable) || (!catalog && selected.id !== null)}
          onClick={() => onApply(selected)}
        >
          {t("warehouse.applyTemplates")}
        </Button>
      }
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      {onRefresh ? (
        <Button size="floor" disabled={busy} onClick={onRefresh}>
          {t("warehouse.pallet.refreshTemplates")}
        </Button>
      ) : null}
      {!catalog ? <Alert tone="warn">{t("warehouse.pallet.v2Unavailable")}</Alert> : null}
      <div className="warehouse-pallet-picker">
        <div
          className="warehouse-pallet-template-list"
          role="group"
          aria-label={t("warehouse.pallet.templateTitle")}
        >
          {choices.map((c) => {
            const reason = palletTemplateUnavailable(source, c, profile),
              key = c.id ?? "original";
            return (
              <Button
                key={key}
                size="floor"
                variant={
                  selected.id === c.id && selected.snapshotDigest === c.snapshotDigest
                    ? "primary"
                    : "secondary"
                }
                aria-pressed={selected.id === c.id && selected.snapshotDigest === c.snapshotDigest}
                disabled={busy || Boolean(reason)}
                onClick={() => setSelected(c)}
              >
                <span>
                  {c.name}
                  <small>
                    {c.kind === "a4"
                      ? `${c.snapshot.spec.page.orientation === "portrait" ? 210 : 297} × ${c.snapshot.spec.page.orientation === "portrait" ? 297 : 210}`
                      : `${c.snapshot.widthMm} × ${c.snapshot.heightMm}`}{" "}
                    {t("warehouse.mm")}
                    {reason ? ` · ${t("warehouse.errors." + reason)}` : ""}
                  </small>
                </span>
              </Button>
            );
          })}
        </div>
        <div className="warehouse-pallet-preview">
          {preview ? (
            <LabelRasterPreview
              bytes={preview}
              label={t("warehouse.previewLabel", { name: selected.name })}
            />
          ) : (
            <p role="status">
              {t(failed ? "warehouse.previewUnavailable" : "warehouse.previewLoading")}
            </p>
          )}
        </div>
      </div>
    </FullScreenDialog>
  );
}
