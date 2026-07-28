import { renderCode128Svg } from "@markiro/domain";

import { pairingBarcodeBoxStyle } from "./pairingBarcodeBox.js";

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
 *
 * The box is pinned to the symbol's intrinsic size and the `<svg>` stretched
 * to fill it, because the generated markup carries only a `viewBox` and would
 * otherwise collapse to 0x0 in the reveal panel -- see `./pairingBarcodeBox.ts`.
 * Same arrangement as `../pickup/OrderDetail.tsx` uses for `ItemCode`.
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
    <>
      <style>{".mk-pairing-barcode svg{width:100%;height:100%;display:block}"}</style>
      <div
        role="img"
        aria-label={label}
        className="mk-pairing-barcode"
        style={pairingBarcodeBoxStyle}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </>
  );
}
