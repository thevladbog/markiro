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
      /\.station-enrollment__actions--pairing\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(
      /\.station-enrollment__actions--service\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s,
    );
    expect(stationSource("pages/Enrollment.tsx")).toContain("const recoveryPanel");
  });

  it("gives the pairing card breathing room and a clear action hierarchy", () => {
    const css = stationSource("station.css");

    expect(css).toMatch(
      /\.station-enrollment__entry\s*\{[^}]*padding:\s*var\(--sp-4\);[^}]*gap:\s*var\(--sp-3\);/s,
    );
    expect(css).toMatch(
      /\.station-enrollment__code-field\s*\{[^}]*flex-direction:\s*column !important;[^}]*align-items:\s*stretch;/s,
    );
    expect(css).toMatch(
      /\.station-enrollment__actions--pairing\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(
      /\.station-enrollment__actions--pairing\s*>\s*:first-child\s*\{[^}]*grid-column:\s*1 \/ -1;/s,
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

  it("keeps the box cells and actions on one bounded instrument surface", () => {
    const css = stationSource("station.css");
    const instrument = stationSource("ui/work/BoxFillInstrument.tsx");

    expect(instrument).toContain('className="work-box-fill__grid"');
    expect(instrument).not.toContain('className="work-box-fill__track"');
    expect(css).not.toContain(".work-box-fill__track");
    expect(css).toMatch(
      /\.work-box-fill__grid\s*\{[^}]*grid-template-columns:\s*repeat\(10, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(/\.work-box-fill__grid\[data-grouped="true"\]\s*\{/s);
    expect(css).toMatch(
      /\.work-box-fill__actions\s*\{(?![^}]*background:)[^}]*min-height:\s*64px;/s,
    );
    expect(css).toMatch(
      /\.work-box-fill\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) minmax\(64px, auto\);/s,
    );
    expect(css).toMatch(
      /\.work-box-fill\[data-grouped="true"\]\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto minmax\(64px, auto\);/s,
    );
    expect(css).toMatch(/\.work-box-fill__grid\s*\{[^}]*height:\s*100%;/s);
    expect(css).toMatch(/\.work-box-fill__cell\s*\{[^}]*height:\s*100%;/s);
    expect(css).toMatch(
      /\.work-box-fill__cell\[data-state="next"\]\s*\{[^}]*outline:\s*3px solid var\(--focus-ring\);/s,
    );
  });

  it("gives box progress most of the work surface at 1024px without hiding the product photo", () => {
    const css = stationSource("station.css");

    expect(css).toMatch(
      /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-screen__primary\s*\{[^}]*grid-template-rows:\s*minmax\(124px, 0\.55fr\) minmax\(0, 1\.45fr\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-scan-result\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.35fr\) minmax\(150px, 0\.65fr\);[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-scan-result__image\s*\{[^}]*width:\s*96px;[^}]*height:\s*96px;/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-box-fill__readout strong\s*\{[^}]*font:\s*var\(--floor-counter-sm\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-scan-result__normalized\s*\{[^}]*-webkit-line-clamp:\s*3;/s,
    );
  });

  it("keeps every print-recovery action floor-sized in a bounded no-scroll dialog", () => {
    const recovery = stationSource("ui/BoxPrintRecovery.tsx");
    const css = stationSource("station.css");

    expect(recovery.match(/<Button/g)).toHaveLength(3);
    expect(recovery.match(/size="floor"/g)).toHaveLength(3);
    expect(recovery).not.toContain('size="compact"');
    expect(recovery).toContain('className="box-print-recovery"');
    expect(css).toMatch(/\.box-print-recovery\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).not.toMatch(/\.box-print-recovery\s*\{[^}]*overflow(?:-y)?:\s*(?:auto|scroll);/s);
  });

  it("keeps floor header actions in bounded grid flow at wide and compact widths", () => {
    const css = stationSource("station.css");

    expect(css).toMatch(
      /\.station-update-indicator\s*\{[^}]*position:\s*static;[^}]*min-height:\s*64px;/s,
    );
    expect(css).not.toMatch(/\.station-update-indicator\s*\{[^}]*position:\s*absolute;/s);
    expect(css).toMatch(
      /\.station-status-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(
      /\.station-status-actions\s*>\s*\*\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*64px;/s,
    );
    expect(css).toMatch(
      /\.station-status-bar\s*\{[^}]*grid-template-columns:[^;}]*minmax\(960px, 2fr\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 1439px\)\s*\{[\s\S]*?\.station-status-bar\s*\{[^}]*grid-template-columns:\s*minmax\(0, 2\.6fr\) minmax\(0, 1fr\) minmax\(0, 1\.1fr\);[^}]*\}[\s\S]*?\.station-status-actions\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 1179px\)\s*\{[\s\S]*?\.station-status-bar\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 1100px\)\s*\{[\s\S]*?\.station-status-bar\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.35fr\) minmax\(0, 1fr\) minmax\(0, 0\.9fr\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 1100px\)\s*\{[\s\S]*?\.shift-selection__grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*grid-auto-rows:\s*minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /\.station-status-actions \.window-mode-control__action\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(css).toMatch(
      /\.station-update-indicator\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(css).toMatch(
      /\.station-status-actions \.window-mode-control__error\s*\{[^}]*display:\s*grid;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
  });
});
