/** Outline the canonical print logo with the already bundled IBM Plex Mono 600.
 * Usage: node generate-markiro-print-logo.mjs <fontkit module path> <cyrillic-600-normal.woff>
 * No runtime font dependency or new package installation is introduced. */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const [modulePath, fontPath] = process.argv.slice(2);
if (!modulePath || !fontPath)
  throw new Error("Provide installed fontkit and bundled Cyrillic 600 WOFF paths");
const fontkit = createRequire(import.meta.url)(resolve(modulePath));
const font = fontkit.openSync(resolve(fontPath));
const source = readFileSync(
  new URL("../../apps/admin/src/assets/markiro-logo-on-light.svg", import.meta.url),
  "utf8",
);
const layout = font.layout("маркиро"),
  scale = 34 / font.unitsPerEm;
let x = 76;
const paths = layout.glyphs
  .map((glyph, index) => {
    const position = layout.positions[index];
    if (!position) throw new Error("Missing glyph position");
    const path = `<path transform="translate(${(x + position.xOffset * scale).toFixed(5)},${(45 - position.yOffset * scale).toFixed(5)}) scale(${scale},${-scale})" d="${glyph.path.toSVG()}"/>`;
    x += position.xAdvance * scale - 0.5;
    return path;
  })
  .join("");
const outlined = source.replace(/<text\b[^>]*>маркиро<\/text>/, `<g fill="#17161A">${paths}</g>`);
if (outlined === source || outlined.includes("<text"))
  throw new Error("Expected canonical source text");
for (const app of ["admin", "station"])
  writeFileSync(
    new URL(`../../apps/${app}/src/assets/markiro-print-logo.svg`, import.meta.url),
    outlined + "\n",
  );
