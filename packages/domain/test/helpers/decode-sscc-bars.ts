import type { MonoRaster } from "../../src/index.js";

// Canonical Code 128 patterns needed by the hand-checked SSCC test fixture.
const patterns: Readonly<Record<string, number>> = {
  "211232": 105,
  "411131": 102,
  "212222": 0,
  "122231": 14,
  "314111": 60,
  "112232": 12,
  "212321": 31,
  "312131": 23,
};
export function decodeFixtureSscc(page: MonoRaster, left: number, width: number): string {
  const black = (x: number, y: number) =>
    Boolean((page.pixels[y * page.stride + (x >> 3)] ?? 0) & (0x80 >> (x % 8)));
  for (let y = page.heightDots - 1; y >= 0; y--) {
    let first = left;
    while (first < left + width && !black(first, y)) first++;
    if (first === left + width) continue;
    let last = left + width - 1;
    while (last >= first && !black(last, y)) last--;
    const runs: number[] = [];
    let ink = true,
      run = 0;
    for (let x = first; x <= last; x++) {
      if (black(x, y) === ink) run++;
      else {
        runs.push(run);
        run = 1;
        ink = !ink;
      }
    }
    runs.push(run);
    if (runs.length < 70) continue;
    const unit = runs[1];
    if (!unit || first - left < 10 * unit || left + width - last - 1 < 10 * unit)
      throw new Error("Missing quiet zone");
    const modules = runs.map((n) => n / unit);
    if (!modules.every(Number.isInteger) || modules.slice(-7).join("") !== "2331112")
      throw new Error("Invalid bars");
    const codes: number[] = [];
    for (let i = 0; i < modules.length - 7; i += 6) {
      const code = patterns[modules.slice(i, i + 6).join("")];
      if (code === undefined) throw new Error("Unknown symbol");
      codes.push(code);
    }
    if (codes[0] !== 105 || codes[1] !== 102) throw new Error("Not GS1 subset C");
    const payload = codes.slice(2, -1);
    const checksum = codes.slice(1, -1).reduce((sum, code, i) => sum + code * (i + 1), 105) % 103;
    if (codes.at(-1) !== checksum) throw new Error("Invalid check symbol");
    return payload.map((code) => String(code).padStart(2, "0")).join("");
  }
  throw new Error("SSCC not found");
}
