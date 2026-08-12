import type { CSSProperties } from "react";

/**
 * Intrinsic size of the pairing barcode's SVG, in CSS px: `renderCode128Svg`
 * emits `viewBox="0 0 158 74"` for any eight-digit code (Code 128 subset C
 * packs the digits into four symbol pairs, so the width does not vary with the
 * value -- verified across `00000000`/`12345678`/`99999999`).
 *
 * The generated `<svg>` carries *no* `width`/`height` attributes, only a
 * `viewBox`. An SVG sized that way has an aspect ratio but no intrinsic width,
 * so inside the reveal panel -- a column flex container with
 * `align-items: center`, which sizes its children to fit-content -- the
 * shrink-to-fit chain resolves to nothing and the barcode collapses to 0x0
 * (measured in Chrome; jsdom has no layout engine, which is why the existing
 * test could not see it). Pinning the box here is what makes it render at all.
 */
export const PAIRING_BARCODE_WIDTH = 158;
export const PAIRING_BARCODE_HEIGHT = 74;

/**
 * Shared by the barcode itself and by the placeholder shown while its lazy
 * chunk loads, so the two boxes are identical by construction and swapping one
 * for the other cannot shift the surrounding layout.
 *
 * Deliberately kept in its own module with no `@markiro/domain` import: pulling
 * these constants straight from `PairingBarcode.tsx` would make the reveal panel
 * statically depend on it and drag bwip-js back into the main admin bundle,
 * defeating the `React.lazy` split it exists for.
 */
export const pairingBarcodeBoxStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: PAIRING_BARCODE_WIDTH,
  height: PAIRING_BARCODE_HEIGHT,
  boxSizing: "content-box",
  padding: 8,
  border: "1px solid var(--line)",
  background: "#fff",
};
