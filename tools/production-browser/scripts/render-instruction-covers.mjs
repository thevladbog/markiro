import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { landingRoot } from "./film-render.mjs";

// Renders the first page of the newest published PDF of each instruction the home page shows,
// in both languages. Uses macOS `sips`; the PNGs are committed, so CI never renders PDFs.
const pdfRoot = path.join(landingRoot, "public/legal/files");
const outputRoot = path.join(landingRoot, "src/assets/home/docs");
const CODES = ["mkr-ins-01", "mkr-ins-02", "mkr-ins-09"];
const LOCALES = ["ru", "en"];

mkdirSync(outputRoot, { recursive: true });
for (const code of CODES) {
  for (const locale of LOCALES) {
    const prefix = `markiro_${code}_`;
    const suffix = `_${locale}.pdf`;
    const latest = readdirSync(pdfRoot)
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .sort()
      .at(-1);
    if (latest === undefined) throw new Error(`no published ${locale} PDF for ${code}`);
    const release = latest.slice(prefix.length, -suffix.length);
    for (const old of readdirSync(outputRoot).filter(
      (name) => name.startsWith(`${code}_`) && name.endsWith(`_${locale}.png`),
    )) {
      rmSync(path.join(outputRoot, old));
    }
    const target = path.join(outputRoot, `${code}_${release}_${locale}.png`);
    execFileSync(
      "sips",
      [
        "-s",
        "format",
        "png",
        "--resampleHeight",
        "1100",
        path.join(pdfRoot, latest),
        "--out",
        target,
      ],
      { stdio: "pipe" },
    );
    console.log(`rendered ${path.basename(target)}`);
  }
}
