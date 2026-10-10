import { expect, it } from "vitest";
import { renderCode128Svg } from "../src/index.js";
it("encodes the SSCC preview as GS1-128 with FNC1 while retaining ordinary Code128", () => {
  const plain = renderCode128Svg("00346006820000000014", { includeText: false });
  const gs1 = renderCode128Svg("(00)346006820000000014", { includeText: false, gs1: true });
  const width = (svg: string) => Number(svg.match(/viewBox="0 0 (\d+)/)?.[1]);
  expect(width(gs1) - width(plain)).toBe(22);
  expect(gs1).not.toContain("!1");
  expect(plain).toBe(renderCode128Svg("00346006820000000014", { includeText: false, gs1: false }));
});
