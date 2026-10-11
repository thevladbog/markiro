import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  encodeMonoRaster,
  renderPalletSheet,
  type PalletSheetTemplateSnapshot,
} from "@markiro/domain";
import { tauriWindowsPrinting } from "../lib/hardware.js";
import type { PrinterProfile } from "../lib/printer-routing.js";
import {
  loadOrganizationBranding,
  type OrganizationBrandingOwner,
} from "../lib/organization-branding.js";
import { rasterizeDriverText } from "../lib/rasterizer.js";
import { LabelRasterPreview } from "./LabelRasterPreview.js";
export type SheetBrandingOwner = Omit<OrganizationBrandingOwner, "client">;
export function PalletSheetPreview({
  template,
  profile,
  owner,
  productName,
  gtin14,
  productionDate,
  egaisCode,
  shelfLifeDays,
  onReadyChange,
}: {
  template: PalletSheetTemplateSnapshot;
  profile: PrinterProfile | null;
  owner: SheetBrandingOwner | undefined;
  productName: string;
  gtin14: string;
  productionDate: string | null;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  onReadyChange: (ready: boolean) => void;
}) {
  const { t } = useTranslation();
  const source = useMemo(
    () => ({
      template,
      profile,
      owner,
      productName,
      gtin14,
      productionDate,
      egaisCode,
      shelfLifeDays,
    }),
    [template, profile, owner, productName, gtin14, productionDate, egaisCode, shelfLifeDays],
  );
  const [result, setResult] = useState<{
    source: typeof source;
    bytes: Uint8Array | null;
    errorKey: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    onReadyChange(false);
    void (async () => {
      if (!owner) throw new Error("Branding unavailable");
      if (
        !owner ||
        !profile ||
        profile.paper !== "a4" ||
        profile.target.kind !== "usb" ||
        !tauriWindowsPrinting.getWindowsPageGeometry
      )
        throw new Error("Sheet unavailable");
      const branding = await loadOrganizationBranding(owner);
      if (!branding) throw new Error("Branding unavailable");
      const geometry = await tauriWindowsPrinting.getWindowsPageGeometry(profile.target.printer, {
        mode: "a4_sheet",
        orientation: template.spec.page.orientation,
      });
      const bytes = encodeMonoRaster(
        await renderPalletSheet(
          template.spec,
          {
            sscc: "146000000000001231",
            productPrintName: productName,
            gtin14,
            egaisCode,
            productionDate,
            shelfLifeDays,
            boxCount: 48,
            itemCount: 576,
            shiftNumber: null,
            organizationName: branding.organizationName,
            logo: branding.logo,
          },
          geometry,
          rasterizeDriverText,
        ),
      );
      if (active && owner.isCurrent()) {
        setResult({ source, bytes, errorKey: null });
        onReadyChange(true);
      }
    })().catch((error: unknown) => {
      const errorKey =
        error instanceof Error && error.message === "Branding unavailable"
          ? "palletSheet.brandingMissing"
          : error instanceof Error && error.message === "Sheet unavailable"
            ? "palletSheet.unsupported"
            : typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "geometry_mismatch"
              ? "palletSheet.geometryMismatch"
              : "palletSheet.layoutFailed";
      if (active) {
        setResult({ source, bytes: null, errorKey });
        onReadyChange(false);
      }
    });
    return () => {
      active = false;
    };
  }, [
    source,
    onReadyChange,
    template,
    profile,
    owner,
    productName,
    gtin14,
    productionDate,
    egaisCode,
    shelfLifeDays,
  ]);
  return result?.source === source && result.bytes ? (
    <LabelRasterPreview
      bytes={result.bytes}
      label={t("palletSheet.preview", { name: template.name })}
    />
  ) : (
    <p role={result?.source === source && result.errorKey ? "alert" : "status"}>
      {t(
        result?.source === source && result.errorKey ? result.errorKey : "warehouse.previewLoading",
      )}
    </p>
  );
}
