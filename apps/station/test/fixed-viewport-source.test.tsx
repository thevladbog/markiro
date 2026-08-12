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

  it("lays out enrollment as a bounded two-column console without inline page styling", () => {
    const css = stationSource("station.css");
    const enrollment = stationSource("pages/Enrollment.tsx");

    expect(enrollment).toContain('className="station-enrollment"');
    expect(enrollment).not.toContain("style={{");
    expect(css).toMatch(
      /\.station-enrollment\s*\{[^}]*display:\s*grid;[^}]*overflow:\s*hidden;[^}]*gap:\s*var\(--sp-[^)]*\);[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(420px, 560px\);/s,
    );
  });

  it("keeps 1280×800 pairing keys floor-sized and makes recovery actions fit the panel", () => {
    const css = stationSource("station.css");

    expect(css).toMatch(
      /\.station-enrollment\s*\{[^}]*--control-keypad:\s*80px;[^}]*grid-template-columns:/s,
    );
    expect(css).not.toMatch(/@media[^{]*max-height:\s*800px/s);
    expect(css).toMatch(
      /@media \(max-width: 1023px\), \(max-height: 767px\)\s*\{[\s\S]*?\.station-enrollment__keypad\s*\{[^}]*--control-keypad:\s*64px;/s,
    );
    expect(css).toMatch(
      /\.station-enrollment__entry\s*\{[^}]*overflow:\s*visible;[^}]*align-content:\s*center;/s,
    );
    expect(css).toMatch(
      /\.station-enrollment__actions\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s,
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
