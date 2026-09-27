import { useMemo } from "react";

import { renderLiteralDataMatrixSvg } from "@markiro/domain";

/**
 * The pairing payload as a DataMatrix code, after
 * `apps/admin/src/pages/devices/PairingBarcode.tsx`. Loaded on its own, since
 * the encoder is large. When it cannot draw the code, nothing shows: the code
 * and the fingerprint beside it stay the way to pair by hand.
 */
export default function PairingDataMatrix({ payload, label }: { payload: string; label: string }) {
  // The dialog's countdown re-renders this component every second; the
  // encoder is expensive enough (bwip-js) that it must not re-run while the
  // payload it is given is unchanged.
  const svg = useMemo(() => {
    try {
      return renderLiteralDataMatrixSvg(payload);
    } catch {
      return null;
    }
  }, [payload]);
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
