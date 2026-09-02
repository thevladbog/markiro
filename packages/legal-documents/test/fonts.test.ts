import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LIBREOFFICE_PROFILE_FONT_DIRECTORIES,
  assertPinnedFontsInstalled,
  stageLibreOfficeFonts,
} from "../src/cli/generate-artifacts.js";

const FONTS_ROOT = fileURLToPath(new URL("../fonts/", import.meta.url));

const PINNED_FONTS = [
  {
    name: "IBMPlexMono-Bold.ttf",
    bytes: 157924,
    sha256: "ca403c56931baef307d20ba64b69acb71abcad61f75e66414661d57484b690ec",
  },
  {
    name: "IBMPlexMono-Regular.ttf",
    bytes: 155940,
    sha256: "fe11304a5fe956d5744e9b6a246cc83d90425245e75a62230044966ca96a7f50",
  },
  {
    name: "IBMPlexSans-Bold.ttf",
    bytes: 200872,
    sha256: "9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f",
  },
  {
    name: "IBMPlexSans-Regular.ttf",
    bytes: 200500,
    sha256: "975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5",
  },
] as const;

describe("vendored fonts", () => {
  it("contains exactly the pinned TTFs plus license and readme", () => {
    expect(readdirSync(FONTS_ROOT).sort()).toEqual([
      ...PINNED_FONTS.map(({ name }) => name),
      "OFL.txt",
      "README.md",
    ]);
  });

  it.each(PINNED_FONTS)("pins $name byte-for-byte", ({ name, bytes, sha256 }) => {
    const content = readFileSync(path.join(FONTS_ROOT, name));
    expect(content.byteLength).toBe(bytes);
    expect(createHash("sha256").update(content).digest("hex")).toBe(sha256);
    // TrueType magic: 0x00010000.
    expect([...content.subarray(0, 4)]).toEqual([0, 1, 0, 0]);
  });

  it("ships the SIL OFL 1.1 license text", () => {
    expect(readFileSync(path.join(FONTS_ROOT, "OFL.txt"), "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
  });
});

describe("assertPinnedFontsInstalled", () => {
  const withTempDir = (run: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), "markiro-system-fonts-"));
    return run(dir).finally(() => rmSync(dir, { force: true, recursive: true }));
  };

  it("passes when every pinned font is installed byte-for-byte", () =>
    withTempDir(async (dir) => {
      for (const { name } of PINNED_FONTS) {
        copyFileSync(path.join(FONTS_ROOT, name), path.join(dir, name));
      }
      await expect(assertPinnedFontsInstalled([dir], "darwin")).resolves.toBeUndefined();
    }));

  it("rejects when a pinned font is missing", () =>
    withTempDir(async (dir) => {
      await expect(assertPinnedFontsInstalled([dir], "darwin")).rejects.toThrow(
        /is not installed for LibreOffice/,
      );
    }));

  it("rejects when an installed font drifts from the pin", () =>
    withTempDir(async (dir) => {
      for (const { name } of PINNED_FONTS) {
        copyFileSync(path.join(FONTS_ROOT, name), path.join(dir, name));
      }
      writeFileSync(path.join(dir, PINNED_FONTS[0].name), "drifted");
      await expect(assertPinnedFontsInstalled([dir], "darwin")).rejects.toThrow(
        /does not match the vendored pin/,
      );
    }));

  it("is a no-op outside macOS", () =>
    withTempDir(async (dir) => {
      await expect(assertPinnedFontsInstalled([dir], "linux")).resolves.toBeUndefined();
    }));
});

describe("stageLibreOfficeFonts", () => {
  it("copies every vendored TTF into both profile font directories", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "markiro-fonts-"));
    try {
      await stageLibreOfficeFonts(profile);
      expect(LIBREOFFICE_PROFILE_FONT_DIRECTORIES).toHaveLength(2);
      for (const directory of LIBREOFFICE_PROFILE_FONT_DIRECTORIES) {
        for (const { name, sha256 } of PINNED_FONTS) {
          const staged = readFileSync(path.join(profile, directory, name));
          expect(createHash("sha256").update(staged).digest("hex")).toBe(sha256);
        }
      }
    } finally {
      rmSync(profile, { force: true, recursive: true });
    }
  });
});
