import { renderDataMatrixSvg } from "@markiro/domain";

/**
 * Full-screen DataMatrix for the sell-at-register flow. Same contract as
 * pickup's ItemCode (default export for React.lazy, try/catch around
 * bwip-js, dangerouslySetInnerHTML of the raw <svg> string) -- see that
 * module's comment for why. Sized by the .mk-sell-code class instead of
 * inline 64px.
 */
export default function SellCode({
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
    return <div className="mk-sell-code mk-sell-code--fallback">{fallbackLabel}</div>;
  }

  return <div className="mk-sell-code" dangerouslySetInnerHTML={{ __html: svg }} />;
}
