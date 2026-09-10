// Synthetic stock-label preview using the production model, renderer and font rasterizers.
import "@markiro/ui/styles.css";
import "../../src/global.css";
import "../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { buildDuplicateLabelTemplate, mmToDots, ptToDots } from "@markiro/domain";
import { PreviewPane } from "../../src/pages/labels/editor/PreviewPane.js";
import { labelPreviewData } from "../../src/pages/labels/preview-data.js";
import { rasterizeText as adminRasterizeText } from "../../src/labels/rasterizer.js";
import { rasterizeText as stationRasterizeText } from "../../../station/src/lib/rasterizer.js";
const params = new URLSearchParams(location.search);
const dpi = params.get("dpi") === "300" ? 300 : 203;
const nameField = params.get("name") === "full" ? "product.name" : "product.printName";
const rasterizeText =
  params.get("rasterizer") === "station" ? stationRasterizeText : adminRasterizeText;
const data = {
  ...labelPreviewData("product_duplicate"),
  "product.name": "Пиво светлое пастеризованное фильтрованное, алкоголь 4,5%, кега 30 литров",
  "product.printName": "Кега светлого пива, 30 л",
  date: "08.09.2026",
  expiry: "08.10.2026",
};
const first = await rasterizeText(data[nameField], {
  fontFamily: "IBM Plex Sans",
  fontSizePx: ptToDots(8, dpi),
  bold: true,
  maxWidthPx: mmToDots(30, dpi),
  maxLines: 3,
});
await document.fonts.load(`700 ${ptToDots(8, dpi)}px IBM Plex Sans`, data[nameField]);
const warmed = await rasterizeText(data[nameField], {
  fontFamily: "IBM Plex Sans",
  fontSizePx: ptToDots(8, dpi),
  bold: true,
  maxWidthPx: mmToDots(30, dpi),
  maxLines: 3,
});
document.documentElement.dataset.coldFontMatch = String(
  JSON.stringify(first) === JSON.stringify(warmed),
);
let rendered = 0;
const root = document.getElementById("root");
if (!root) throw new Error("root missing");
createRoot(root).render(
  <div style={{ padding: 40 }}>
    <PreviewPane
      spec={buildDuplicateLabelTemplate(dpi, nameField)}
      purpose="product_duplicate"
      data={data}
      scale={12}
      rasterizeText={async (...args) => {
        const result = await rasterizeText(...args);
        rendered++;
        if (rendered === 5) document.documentElement.dataset.labelRaster = "ready";
        return result;
      }}
    />
  </div>,
);
