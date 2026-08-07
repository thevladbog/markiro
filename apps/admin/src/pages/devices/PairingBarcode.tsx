import { renderCode128Svg } from "@markiro/domain";

import { pairingBarcodeBoxStyle } from "../kiosks/pairingBarcodeBox.js";

/**
 * Encodes the exact one-time pairing digits once for every cabinet surface.
 * The caller validates the eight-digit contract; renderer failures leave the
 * visible, accessible digits as the recovery path.
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
