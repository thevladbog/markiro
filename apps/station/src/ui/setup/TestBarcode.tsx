import { renderCode128Svg } from "@markiro/domain";

/**
 * A hardware-check code as an on-screen Code 128 symbol, big enough to scan
 * straight off the monitor. Same arrangement as the admin's PairingBarcode:
 * `renderCode128Svg` returns a raw `<svg>` string (viewBox only), hence
 * `dangerouslySetInnerHTML` and an explicit box for it to fill. An encoder
 * throw degrades to nothing — the plain code caption next to this component
 * remains, and the operator can still judge the scan by the verdict line.
 */
export function TestBarcode({ code, label }: { code: string; label: string }) {
  let svg: string | null;
  try {
    svg = renderCode128Svg(code, { includeText: false });
  } catch {
    svg = null;
  }
  if (!svg) return null;
  return (
    <div
      role="img"
      aria-label={label}
      className="setup-barcode"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
