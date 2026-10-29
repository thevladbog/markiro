// Pixel difference of two capture runs (ImageMagick's `compare -metric AE`), frame by frame.
//   node compare.mjs <dirA> <dirB> [--fuzz 2%]
// `--fuzz` ignores colour differences up to that share, as rounded-corner antialiasing.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { fuzz: { type: "string" } },
});
const [a, b] = positionals;
if (!a || !b) {
  console.error("usage: node compare.mjs <dirA> <dirB> [--fuzz 2%]");
  process.exit(2);
}
const fuzz = values.fuzz === undefined ? [] : ["-fuzz", values.fuzz];
let differing = 0;
for (const name of readdirSync(a)
  .filter((file) => file.endsWith(".png") && !file.includes(".failed-"))
  .sort()) {
  const other = path.join(b, name);
  if (!existsSync(other)) {
    console.log(`${name}: missing in ${b}`);
    differing += 1;
    continue;
  }
  let pixels;
  try {
    execFileSync(
      "magick",
      ["compare", "-metric", "AE", ...fuzz, path.join(a, name), other, "null:"],
      {
        stdio: "pipe",
      },
    );
    pixels = "0";
  } catch (error) {
    pixels = String(error.stderr).trim().split(/\s/)[0];
  }
  if (pixels !== "0") differing += 1;
  console.log(`${name}: ${pixels}`);
}
process.exit(differing === 0 ? 0 : 1);
