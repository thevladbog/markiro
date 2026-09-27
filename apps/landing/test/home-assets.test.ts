import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const COVER_CODES = ["mkr-ins-01", "mkr-ins-02", "mkr-ins-09"] as const;
const LOCALES = ["en", "ru"] as const;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function publishedReleases(code: string, locale: string): string[] {
  const prefix = `markiro_${code}_`;
  const suffix = `_${locale}.pdf`;
  return readdirSync(path.join(appRoot, "public/legal/files"))
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => name.slice(prefix.length, -suffix.length))
    .sort();
}

describe("home page assets", () => {
  it("keeps the case labels identical to the published examples", () => {
    for (const group of ["juices", "cosmetics"]) {
      expect(sha256(path.join(appRoot, `src/assets/home/labels/${group}-box.png`)), group).toBe(
        sha256(path.join(repoRoot, `examples/labels/${group}/box-100x150.png`)),
      );
    }
  });

  it("shows the current release of every instruction cover in both languages", () => {
    const covers = readdirSync(path.join(appRoot, "src/assets/home/docs")).filter((name) =>
      name.endsWith(".png"),
    );
    expect(covers.map((name) => name.replace(/_[^_]+_(ru|en)\.png$/u, "_$1")).sort()).toEqual(
      COVER_CODES.flatMap((code) => LOCALES.map((locale) => `${code}_${locale}`)).sort(),
    );
    for (const cover of covers) {
      const [code, release, locale] = cover.replace(/\.png$/u, "").split("_");
      if (code === undefined || release === undefined || locale === undefined) {
        throw new Error(`bad cover name ${cover}`);
      }
      expect(release, cover).toBe(publishedReleases(code, locale).at(-1));
    }
  });
});
