import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = existsSync(resolve(process.cwd(), "apps/station/src/station.css"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");

function stationSource(path: string): string {
  return readFileSync(resolve(repositoryRoot, "apps/station/src", path), "utf8");
}

describe("fixed station viewport source contract", () => {
  it("keeps boot, recovery, and enrollment screens inside the station root instead of viewport units", () => {
    expect(stationSource("App.tsx")).not.toContain("100vh");
    expect(stationSource("pages/Enrollment.tsx")).not.toContain("100vh");
    expect(stationSource("station.css")).toMatch(
      /\.station-centered-screen\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s,
    );
  });

  it("keeps shared alert copy at floor-readable size inside the station application", () => {
    expect(stationSource("station.css")).toMatch(
      /#root \.mk-alert > span,[^{]+\{[^}]*font-size:\s*18px !important;[^}]*line-height:\s*26px !important;/s,
    );
  });

  it("keeps the station application on the bundled sans family by default", () => {
    expect(stationSource("station.css")).toMatch(
      /\.station-root\s*\{[^}]*font-family:\s*var\(--font-ui\);/s,
    );
  });

  it("gives enabled actions pressed motion while disabled actions stay fixed", () => {
    const css = stationSource("station.css");

    expect(css).toMatch(
      /#root :where\(button, \[role="button"\], a\[href\]\):active:not\(:disabled\):not\(\[aria-disabled="true"\]\)\s*\{[^}]*transform:\s*translateY\(1px\);/s,
    );
    expect(css).toMatch(
      /#root :where\(button, \[role="button"\], a\[href\]\):is\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*transform:\s*none;/s,
    );
  });
});
