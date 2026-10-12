import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PalletSheetSpecV2 } from "@markiro/domain";
import { Alert, Spinner } from "@markiro/ui";

import { loadBundledMarkiroLogo, logoFromWire, sheetLogoOf } from "../../labels/logo.js";
import {
  paintMonoRaster,
  renderSheetRaster,
  sampleSheetContext,
} from "../../labels/sheet-render.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";

/** Dots per preview pixel: an A4 portrait sheet (2480 dots) is 620 px wide. */
const FACTOR = 4;

export interface SheetPreviewProps {
  /** Keep it the same object while the sheet is the same: a new one draws the sheet again. */
  spec: PalletSheetSpecV2;
  /** The canvas's accessible name: the sheet's name. */
  label: string;
}

/**
 * The sheet as it prints, after the cloud admin's `ShiftPalletSheetPreview`:
 * the domain's renderer on synthetic data, with the organization's real name
 * and INN and its logo — or the bundled Markiro logo — at the nominal A4
 * geometry the station prints at. A sheet that does not render (a text that
 * does not fit, no font), or an organization or logo that did not load, says
 * so instead of a blank canvas.
 */
export function SheetPreview({ spec, label }: SheetPreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const logo = useOfficeQuery(officeKeys.orgLogo, (api, token) => api.getOrgLogo(token));
  const [failed, setFailed] = useState(false);
  const orgData = org.data;
  const logoData = logo.data;

  useEffect(() => {
    if (orgData === undefined || logoData === undefined) return undefined;
    let cancelled = false;
    const organization = { name: orgData.name, inn: orgData.inn };
    const own = logoData.logo === null ? null : logoFromWire(logoData.logo);
    const draw = async () => {
      const bitmap = own ?? (await loadBundledMarkiroLogo());
      const raster = await renderSheetRaster(
        spec,
        sampleSheetContext(
          organization,
          sheetLogoOf(bitmap, own === null ? "markiro" : "organization"),
        ),
      );
      if (!cancelled && canvasRef.current !== null) {
        paintMonoRaster(canvasRef.current, raster, FACTOR);
      }
    };
    setFailed(false);
    draw().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [spec, orgData, logoData]);

  const unavailable = org.isError || logo.isError;
  return (
    <>
      {(failed || unavailable) && (
        <Alert tone="error">
          {t(
            unavailable
              ? "office.palletSheets.previewUnavailable"
              : "office.palletSheets.previewFailed",
          )}
        </Alert>
      )}
      {!unavailable && (org.isPending || logo.isPending) && (
        <Spinner label={t("office.common.loading")} />
      )}
      <canvas ref={canvasRef} className="sheet-preview" role="img" aria-label={label} />
    </>
  );
}
