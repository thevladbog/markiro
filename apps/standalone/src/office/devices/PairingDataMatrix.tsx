import { renderLiteralDataMatrixSvg } from "@markiro/domain";

/**
 * The pairing payload as a DataMatrix code, after
 * `apps/admin/src/pages/devices/PairingBarcode.tsx`. Loaded on its own, since
 * the encoder is large. When it cannot draw the code, nothing shows: the code
 * and the fingerprint beside it stay the way to pair by hand.
 */
export default function PairingDataMatrix({ payload, label }: { payload: string; label: string }) {
  let svg: string | null;
  try {
    svg = renderLiteralDataMatrixSvg(payload);
  } catch {
    svg = null;
  }
  if (svg === null) return null;
  return (
    <div
      role="img"
      aria-label={label}
      className="pairing-code__matrix"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
