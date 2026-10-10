/**
 * The domain's ZPL and TSPL generators, loaded on their own
 * (`import("./label-emitters.js")`): they bring the barcode encoder with them
 * (about 0.9 MB), which the station needs only once a box closes, not when
 * the app starts. The office loads the same code through its own chunk.
 */
export { generateTspl, generateZpl } from "@markiro/domain";
