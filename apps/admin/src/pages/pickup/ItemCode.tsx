import { renderDataMatrixSvg } from "@markiro/domain";

/**
 * Renders an item's DataMatrix inline as an SVG string
 * (`renderDataMatrixSvg` -- `@markiro/domain`), embedded via
 * `dangerouslySetInnerHTML` since that function returns a raw `<svg>…</svg>`
 * string, not a React element. Wrapped in try/catch: bwip-js's
 * `gs1datamatrix` encoder enforces the AI-01 GTIN check digit and THROWS on a
 * malformed stored KM -- that must not crash the whole detail card, so a
 * single bad code falls back to a small placeholder instead.
 *
 * Isolated in its own module (default export) so `OrderDetail` can pull it in
 * via `React.lazy` -- that keeps bwip-js (a heavy dependency, reached only
 * through `@markiro/domain`'s barcode renderer) out of the main admin bundle
 * and in a chunk loaded lazily on the order-detail route.
 */
export default function ItemCode({
  rawKm,
  fallbackLabel,
}: {
  rawKm: string;
  fallbackLabel: string;
}) {
  let svg: string | null;
  try {
    svg = renderDataMatrixSvg(rawKm);
  } catch {
    svg = null;
  }

  if (!svg) {
    return (
      <span style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>{fallbackLabel}</span>
    );
  }

  return (
    <div
      className="mk-pickup-dm"
      style={{ width: 64, height: 64, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
