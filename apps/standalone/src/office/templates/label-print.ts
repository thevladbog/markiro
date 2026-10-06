/**
 * The domain's printing code, loaded on its own (`import("./label-print.js")`):
 * the ZPL and TSPL generators and the GS1 DataMatrix raster bring the barcode
 * encoder (bwip-js, about 0.9 MB) with them, which the webview needs only once
 * a duplicate's code is drawn or a code file is saved, not when it starts.
 */
export { generateTspl, generateZpl, rasterizeGs1DataMatrix } from "@markiro/domain";
