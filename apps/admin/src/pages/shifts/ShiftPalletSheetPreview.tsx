import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Spinner } from "@markiro/ui";
import { rasterizeText } from "../../labels/rasterizer.js";
import { SheetCanvas } from "../labels/editor/sheet/SheetCanvas.js";
import { loadCabinetSheetBranding } from "../labels/editor/sheet/sheet-branding.js";
import { useSavedShiftSheet, type ShiftDto } from "./api.js";
export function ShiftPalletSheetPreview({ shift }: { shift: ShiftDto }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const saved = useSavedShiftSheet(shift, open);
  return (
    <section className="mk-shift-details__section">
      <h3>{t("pages.shifts.form.sheetLabel")}</h3>
      <p>
        {shift.palletSheetTemplateName} ·{" "}
        {t("pages.shifts.form.sheetRevision", { revision: shift.palletSheetTemplateRevision })}
      </p>
      <Button variant="secondary" onClick={() => setOpen(!open)}>
        {t("pages.shifts.form.sheetPreview")}
      </Button>
      {open ? (
        <>
          <p>{t("pages.shifts.form.sheetPreviewHint")}</p>
          {saved.isPending ? <Spinner label={t("common.loading")} /> : null}
          {saved.isError ? (
            <Alert tone="error">{t("pages.shifts.form.sheetPreviewError")}</Alert>
          ) : null}
          {saved.data ? (
            <SheetCanvas
              spec={saved.data.spec}
              rasterizeText={rasterizeText}
              loadBranding={loadCabinetSheetBranding}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
