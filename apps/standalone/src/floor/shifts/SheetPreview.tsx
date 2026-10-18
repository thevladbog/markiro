import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PalletSheetSpecV2 } from "@markiro/domain";
import { Alert } from "@markiro/ui";
import { z } from "zod";

import { loadBundledMarkiroLogo, sheetLogoOf } from "../../labels/logo.js";
import {
  paintMonoRaster,
  renderSheetRaster,
  sampleSheetContext,
} from "../../labels/sheet-render.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { readKnownOrganizationLogo } from "../warehouse/warehouse-logo.js";

/** Dots per preview pixel: an A4 portrait sheet (2480 dots) is 620 px wide. */
const FACTOR = 5;

const organizationRow = z.object({ name: z.string(), inn: z.string().nullable() });

export interface SheetPreviewProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** Keep it the same object while the sheet is the same: a new one draws the sheet again. */
  spec: PalletSheetSpecV2;
  /** The canvas's accessible name. */
  label: string;
}

/**
 * The A4 sheet a pallet of the new shift prints, as the print path draws it
 * (`renderSheetRaster`, the one renderer of preview and print), on the sample
 * pallet of the office's preview with this station's organization: its name and
 * INN from the copies and its logo as the newest shift snapshot froze it, else
 * the bundled Markiro logo.
 */
export function SheetPreview({ local, pairing, spec, label }: SheetPreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    let cancelled = false;
    const draw = async () => {
      const [organization] = await local.query(
        "SELECT name, inn FROM ref_org",
        [],
        organizationRow,
      );
      if (organization === undefined) throw new Error("the copies hold no organization");
      const own = await readKnownOrganizationLogo(local, { hostId, deviceId }).catch(() => null);
      const bitmap = own ?? (await loadBundledMarkiroLogo());
      const raster = await renderSheetRaster(
        spec,
        sampleSheetContext(
          organization,
          sheetLogoOf(bitmap, own === null ? "markiro" : "organization"),
        ),
      );
      if (!cancelled && canvasRef.current !== null)
        paintMonoRaster(canvasRef.current, raster, FACTOR);
    };
    setFailed(false);
    draw().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [spec, local, hostId, deviceId]);

  return (
    <>
      {failed && <Alert tone="warn">{t("floor.newShift.sheetPreviewFailed")}</Alert>}
      <canvas ref={canvasRef} className="new-shift__preview-label" role="img" aria-label={label} />
    </>
  );
}
