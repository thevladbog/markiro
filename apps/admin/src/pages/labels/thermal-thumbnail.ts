import type { QueryClient } from "@tanstack/react-query";
import {
  renderMonoLabel,
  type LabelTemplateSpec,
  type LabelTemplatePurpose,
} from "@markiro/domain";
import { rasterizeText } from "../../labels/rasterizer.js";
import { loadCabinetSheetBranding } from "./editor/sheet/sheet-branding.js";
import { paintSheetRaster } from "./editor/sheet/sheet-preview.js";
import { labelPreviewData } from "./preview-data.js";

/** Kept separate from A4's overview renderer so its library optimisations
 * cannot remove resources needed by thermal logo thumbnails. */
export async function paintThermalThumbnail(
  canvas: HTMLCanvasElement,
  spec: LabelTemplateSpec,
  purpose: LabelTemplatePurpose,
  isCurrent: () => boolean,
  queryClient: QueryClient,
): Promise<void> {
  // AuthQueryBoundary owns the cache; profile/logo mutations invalidate its prefix.
  const branding = await queryClient.fetchQuery({
    queryKey: ["org-profile", "print-branding"],
    queryFn: () => loadCabinetSheetBranding(),
    staleTime: 60_000,
    retry: false,
  });
  if (!isCurrent()) return;
  const raster = await renderMonoLabel(spec, labelPreviewData(purpose), rasterizeText, {
    logo: branding.logo,
  });
  if (isCurrent()) paintSheetRaster(canvas, raster);
}
