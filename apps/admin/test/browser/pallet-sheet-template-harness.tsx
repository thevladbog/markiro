import "@markiro/ui/styles.css";
import "../../src/global.css";
import "../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { buildPalletSheetPresets, encodeMonoRaster } from "@markiro/domain";
import { LabelEditorPage } from "../../src/pages/labels/editor/index.js";
import { rasterizeText as adminText } from "../../src/labels/rasterizer.js";
import { rasterizeText as stationText } from "../../../station/src/lib/rasterizer.js";
import { decodeStationBrandingLogo } from "../../../station/src/lib/organization-branding.js";
import { loadCabinetSheetBranding } from "../../src/pages/labels/editor/sheet/sheet-branding.js";
import {
  loadSheetPreviewLogo,
  previewSheetContext,
  renderSheetPreview,
  paintSheetRaster,
} from "../../src/pages/labels/editor/sheet/sheet-preview.js";
const params = new URLSearchParams(location.search);
const element = document.getElementById("root");
if (!element) throw new Error("root missing");
const root: HTMLElement = element;
if (params.has("editor")) {
  const router = createMemoryRouter(
    [
      { path: "/labels/new", element: <LabelEditorPage /> },
      { path: "/labels/:id", element: <LabelEditorPage /> },
      { path: "/labels", element: <p>Library</p> },
    ],
    {
      initialEntries: [
        `/labels/new?format=pallet_sheet_v2&preset=${params.get("preset") ?? "pallet-a4-portrait"}`,
      ],
    },
  );
  createRoot(root).render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
} else {
  async function render() {
    const preset = buildPalletSheetPresets().find(
      (item) => item.key === (params.get("preset") ?? "pallet-a4-portrait"),
    );
    if (!preset) throw new Error("Missing preset");
    const logo = await loadSheetPreviewLogo(params.has("wide"));
    const context = previewSheetContext(
      {
        date: !params.has("noDate"),
        egais: !params.has("noEgais"),
        longName: params.has("long"),
        maximumCounts: params.has("max"),
      },
      logo,
    );
    if (params.has("branding")) {
      const actual = await loadCabinetSheetBranding();
      context.logo = actual.logo;
      context.organizationName = actual.organizationName;
      const source = await fetch("/test/browser/branding-company.webp").then((response) =>
        response.blob(),
      );
      const stationLogo = await decodeStationBrandingLogo(source);
      document.documentElement.dataset.brandingParity = String(
        stationLogo.width === actual.logo.width &&
          stationLogo.height === actual.logo.height &&
          Array.from(stationLogo.pixels).every((byte, index) => byte === actual.logo.pixels[index]),
      );
      document.documentElement.dataset.brandingName = actual.organizationName;
      document.documentElement.dataset.brandingSize = `${actual.logo.width}x${actual.logo.height}`;
    }
    const spec = { ...preset.spec, footer: { ...preset.spec.footer, barHeightMm: 45 } };
    const admin = await renderSheetPreview(spec, context, adminText),
      station = await renderSheetPreview(spec, context, stationText);
    const bytes = encodeMonoRaster(admin),
      other = encodeMonoRaster(station);
    document.documentElement.dataset.sheetParity = String(
      bytes.length === other.length && bytes.every((byte, index) => byte === other[index]),
    );
    const canvas = document.createElement("canvas");
    canvas.style.width = `${admin.widthMm * 2}px`;
    canvas.style.height = `${admin.heightMm * 2}px`;
    root.append(canvas);
    paintSheetRaster(canvas, admin);
    document.documentElement.dataset.sheetReady = "true";
  }
  await render().catch((error: unknown) => {
    document.documentElement.dataset.sheetError =
      error instanceof Error ? error.message : String(error);
    root.textContent = document.documentElement.dataset.sheetError;
  });
}
