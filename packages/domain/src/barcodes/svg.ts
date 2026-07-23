import bwipjs from "bwip-js";

/** GS (0x1D) → bwip-js parse escape so DataMatrix encodes the FNC1 separator. */
function encodeGs(text: string): string {
  return text.replace(/\x1D/g, "^029");
}

export function renderDataMatrixSvg(text: string): string {
  return bwipjs.toSVG({ bcid: "datamatrix", text: encodeGs(text), parse: true, scale: 3 });
}

export function renderQrSvg(text: string): string {
  return bwipjs.toSVG({ bcid: "qrcode", text, scale: 3 });
}

export function renderCode128Svg(text: string): string {
  return bwipjs.toSVG({ bcid: "code128", text, scale: 2, height: 10, includetext: true, textxalign: "center" });
}
