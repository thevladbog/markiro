/**
 * The domain's printing code, loaded on its own (`import("./label-print.js")`):
 * the GS1 DataMatrix raster brings the barcode encoder (bwip-js, about
 * 0.9 MB) with it, which the webview needs only once a duplicate's code is
 * drawn, not when it starts.
 */
export { rasterizeGs1DataMatrix } from "@markiro/domain";
