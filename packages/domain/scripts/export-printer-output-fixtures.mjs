import { writeFile } from "node:fs/promises";
import { applyPrinterOutputMode } from "../dist/index.js";

const cases = [];
for (const language of ["zpl", "tspl"]) {
  const input =
    language === "zpl"
      ? new TextEncoder().encode("^XA\n^GFA,1,1,1,FF^FS\n^XZ\n")
      : new Uint8Array([
          ...new TextEncoder().encode("SIZE 10 mm, 10 mm\nBITMAP 0,0,1,3,0,"),
          0,
          128,
          255,
          10,
          ...new TextEncoder().encode("PRINT 1\n"),
        ]);
  for (const mode of [undefined, "normal", "peel", "cutter"]) {
    cases.push({
      language,
      mode: mode ?? null,
      inputHex: Buffer.from(input).toString("hex"),
      outputHex: Buffer.from(applyPrinterOutputMode(input, language, mode)).toString("hex"),
    });
  }
}
await writeFile(
  new URL(
    "../../../apps/handheld/app/src/test/resources/printer-output-modes.json",
    import.meta.url,
  ),
  JSON.stringify(cases, null, 2) + "\n",
);
