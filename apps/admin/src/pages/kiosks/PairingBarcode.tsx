import { renderCode128Svg } from "@markiro/domain";

/**
 * Renders a kiosk pairing code as a Code 128 barcode, so an operator can scan
 * it with the kiosk's own scanner instead of typing eight digits (design brief
 * 07 §2: "the same code as a barcode beside it, for scanning").
 *
 * `renderCode128Svg` returns a raw `<svg>…</svg>` string rather than a React
 * element, hence `dangerouslySetInnerHTML` -- the same arrangement as
 * `../pickup/ItemCode.tsx`. The input is always eight digits minted
 * server-side, which Code 128 encodes unconditionally, but the render is still
 * wrapped in try/catch so an unexpected encoder throw degrades to the plain
 * digits (already shown above it) instead of taking down the reveal modal.
 *
 * Isolated in its own module (default export) so `PairingCodeModal` can pull
 * it in via `React.lazy`, keeping bwip-js -- a heavy dependency reached
 * through `@markiro/domain`'s barcode renderers -- out of the main admin
 * bundle and in a chunk fetched only when a code is actually issued.
 */
export default function PairingBarcode({ code, label }: { code: string; label: string }) {
  let svg: string | null;
  try {
    svg = renderCode128Svg(code);
  } catch {
    svg = null;
  }

  if (!svg) return null;

  return (
    <div
      role="img"
      aria-label={label}
      style={{ display: "flex", justifyContent: "center", padding: "4px 0" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
