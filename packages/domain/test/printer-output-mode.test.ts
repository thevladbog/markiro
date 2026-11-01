import { readFileSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { applyPrinterOutputMode } from "../src/labels/printer-output-mode.js";

describe("printer output modes", () => {
  const zpl = new TextEncoder().encode("^XA\n^GFA,1,1,1,FF^FS\n^XZ\n");
  const tspl = new Uint8Array([
    ...new TextEncoder().encode("SIZE 10 mm, 10 mm\nBITMAP 0,0,1,1,0,"),
    0,
    128,
    255,
    10,
    ...new TextEncoder().encode("PRINT 1\n"),
  ]);
  it("keeps legacy documents byte-for-byte", () => {
    expect(applyPrinterOutputMode(zpl, "zpl")).toBe(zpl);
    expect(applyPrinterOutputMode(tspl, "tspl")).toBe(tspl);
  });
  it.each([
    ["normal", "T"],
    ["peel", "P"],
    ["cutter", "C"],
  ] as const)("sets ZPL %s within the format", (mode, command) => {
    const bytes = applyPrinterOutputMode(zpl, "zpl", mode);
    expect(new TextDecoder().decode(bytes)).toBe(
      `^XA\n^MM${command}\n` + new TextDecoder().decode(zpl.slice(3)),
    );
  });
  it.each([
    ["normal", "SET CUTTER OFF\nSET PEEL OFF\n"],
    ["peel", "SET CUTTER OFF\nSET PEEL ON\n"],
    ["cutter", "SET PEEL OFF\nSET CUTTER 1\n"],
  ] as const)("sets TSPL %s and preserves raw bitmap bytes", (mode, commands) => {
    const bytes = applyPrinterOutputMode(tspl, "tspl", mode);
    const prefix = new TextEncoder().encode(commands);
    expect(bytes.slice(0, prefix.length)).toEqual(prefix);
    expect(bytes.slice(prefix.length)).toEqual(tspl);
  });
});

it("keeps the shared Android byte fixtures current", () => {
  const cases = z
    .array(
      z.object({
        language: z.enum(["zpl", "tspl"]),
        mode: z.enum(["normal", "peel", "cutter"]).nullable(),
        inputHex: z.string(),
        outputHex: z.string(),
      }),
    )
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../apps/handheld/app/src/test/resources/printer-output-modes.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  expect(cases).toHaveLength(8);
  for (const fixture of cases) {
    const output = applyPrinterOutputMode(
      Uint8Array.from(Buffer.from(fixture.inputHex, "hex")),
      fixture.language,
      fixture.mode ?? undefined,
    );
    expect(Buffer.from(output).toString("hex")).toBe(fixture.outputHex);
  }
});
