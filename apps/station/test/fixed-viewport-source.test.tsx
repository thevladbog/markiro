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
      /#root \.mk-alert > span:not\(\.mk-badge\),[^{]+\{[^}]*font-size:\s*18px !important;[^}]*line-height:\s*26px !important;/s,
    );
  });

  it("lets a strict grant denial wrap and scroll within the task header", () => {
    expect(stationSource("station.css")).toMatch(
      /\.shift-selection__message\s*\{[^}]*min-height:\s*64px;[^}]*max-height:\s*min\(144px, 18vh\);[^}]*overflow:\s*auto;/s,
    );
  });

  it("requests device authority before task authority only for new durable work", () => {
    const app = stationSource("App.tsx");
    expect(app.match(/await refreshStationTaskAuthority\(\{/g)).toHaveLength(2);
    expect(app).toContain('task: { taskKind: "shift", taskId: entered.id }');
    expect(app).toContain('task: { taskKind: "inventory", taskId: entered.inventory.inventoryId }');
    // Both handlers hand the resume verdict to the shared entry admission,
    // which is what skips new-work consumption for a resumed task; see
    // `admitTaskEntry` and test/shift-entry-admission.test.ts.
    expect(
      app.match(
        /resuming: Boolean\(authority\?\.resuming\) \|\| \(await replacementBlocksNewWork\(tauriExecutor\)\),/g,
      ),
    ).toHaveLength(2);
  });

  it("keeps the alert badge compact so two-word badges do not read as double-spaced", () => {
    expect(stationSource("station.css")).toMatch(
      /#root \.mk-alert \.mk-badge\s*\{[^}]*font-size:\s*14px !important;[^}]*line-height:\s*20px !important;/s,
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
      /\.work-box-fill\s*\{[^}]*grid-template-rows:\s*auto minmax\(96px, 1fr\) minmax\(64px, auto\);/s,
    );
    expect(css).toMatch(
      /\.work-box-fill\[data-grouped="true"\]\s*\{[^}]*grid-template-rows:\s*auto minmax\(96px, 1fr\) auto minmax\(64px, auto\);/s,
    );
    expect(css).toMatch(/\.work-box-fill__grid\s*\{[^}]*height:\s*100%;/s);
    expect(css).toMatch(/\.work-box-fill__cell\s*\{[^}]*height:\s*100%;/s);
    expect(css).toMatch(
      /\.work-box-fill__cell\[data-state="next"\]\s*\{[^}]*outline:\s*3px solid var\(--focus-ring\);/s,
    );
  });

  it("puts the shift band above two work columns and never lets the box grid collapse", () => {
    const css = stationSource("station.css");
    expect(stationSource("pages/WorkScreen.tsx")).toContain('className="work-screen__work"');
    expect(css).toMatch(
      /\.work-screen__work\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /\.work-screen__instruments\s*\{[^}]*grid-template-columns:\s*minmax\(0, 3fr\) minmax\(340px, 2fr\);/s,
    );
    expect(css).toMatch(
      /\.work-screen__primary:has\(> \.pallet-strip\)\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s,
    );
    // The band's photo keeps its 3:4 portrait; at 1024 it shrinks to 60px wide.
    expect(css).toMatch(/\.work-shift-band__image\s*\{[^}]*aspect-ratio:\s*3 \/ 4;/s);
    expect(css).toMatch(
      /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-shift-band__image\s*\{[^}]*width:\s*60px;/s,
    );
    // Both pallet actions sit side by side instead of stacking.
    expect(css).toMatch(/\.pallet-strip__actions\s*\{[^}]*grid-auto-flow:\s*column;/s);
    expect(css).not.toContain(".work-counters");
    expect(css).not.toContain("data-identity-only");
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
    const statusBar = stationSource("ui/StatusBar.tsx");

    // `relative` only makes the button the containing block for its dot; the
    // button itself stays in the header grid's flow, never absolute.
    expect(css).toMatch(/\.station-update-indicator\s*\{[^}]*position:\s*relative;/s);
    expect(css).not.toMatch(/\.station-update-indicator\s*\{[^}]*position:\s*absolute;/s);
    expect(statusBar.match(/<Button/g)).toHaveLength(3);
    expect(statusBar.match(/size="floor"/g)).toHaveLength(3);
    expect(statusBar.match(/variant="secondary"/g)).toHaveLength(3);
    // The identity column is the ONLY flexible track: pills and actions size
    // to content, so no fixed floor can starve the station/operator names the
    // way the old minmax(960px, …) actions column did.
    expect(css).toMatch(
      /\.station-status-actions\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*flex-end;/s,
    );
    // The rail is one row at every width: no wrapping, and its controls keep
    // the 64px floor touch target -- the production gallery contract rejects
    // any interactive element below 64px, so nothing here redefines
    // `--control-floor`.
    expect(css).not.toMatch(/\.station-status-actions[^{]*\{[^}]*--control-floor/s);
    expect(css).not.toMatch(/\.station-rail-button[^{]*\{[^}]*--control-floor/s);
    expect(css).toMatch(/\.station-status-actions\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(css).toMatch(
      /\.station-status-actions\s*>\s*\*\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*64px;/s,
    );
    expect(css).toMatch(
      /\.station-status-actions :where\(button, \[role="button"\]\)\s*\{[^}]*min-height:\s*64px;/s,
    );
    expect(css).toMatch(/\.station-rail-button--icon\s*\{[^}]*width:\s*64px;/s);
    expect(css).not.toMatch(
      /\.station-status-actions\s*>\s*\*\s*\{[^}]*(?<![a-z-])width:\s*100%;/s,
    );
    expect(css).toMatch(
      /\.station-status-bar\s*\{[^}]*min-height:\s*80px;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto;/s,
    );
    expect(css).not.toMatch(/\.station-status-bar\s*\{[^}]*minmax\(960px/s);
    // Below 1680 the healthy pills drop their caption and keep the tone dot.
    expect(css).toMatch(
      /@media \(max-width: 1679px\)\s*\{[\s\S]*?\.station-status-pill\[data-value-shown="false"\] dt\s*\{[^}]*clip:\s*rect\(0 0 0 0\);/s,
    );
    // ...and the rail never drops to a second row because of a viewport width:
    // the 1024px terminal shows the same single 80px header as a 1920px one.
    // The one exception is a control's error banner, which is not part of the
    // 80px budget — and that rule is gated on the banner, not on a width.
    expect(css).not.toMatch(/@media \(max-width: 1599px\)/);
    expect(css.match(/\.station-status-actions\s*\{[^}]*flex-wrap:\s*wrap;/gs) ?? []).toHaveLength(
      1,
    );
    expect(
      css.match(/\.station-status-actions\s*\{[^}]*grid-column:\s*1 \/ -1;/gs) ?? [],
    ).toHaveLength(1);
    expect(css).toMatch(
      /\.station-status-bar:has\([^)]*__error[^)]*\)\s*\.station-status-actions\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*flex-wrap:\s*wrap;/s,
    );
    // A pill that has nothing to say paints no value text at any width.
    expect(css).toMatch(
      /\.station-status-pill\[data-value-shown="false"\] dd\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 1100px\)\s*\{[\s\S]*?\.shift-selection__grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*\}[\s\S]*?\.shift-card__body\s*\{[^}]*grid-template-columns:\s*minmax\(150px, 38%\) minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /\.station-status-actions \.window-mode-control__action\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    // The update indicator is a glyph button now: nothing to wrap, and the
    // availability dot is placed against the button itself (in flow, never
    // absolutely positioned out of the header grid).
    expect(css).toMatch(/\.station-rail-button\s*\{[^}]*min-height:\s*64px/s);
    expect(css).toMatch(/\.station-update-indicator__dot\s*\{/s);
    expect(css).toMatch(
      /\.station-status-actions \.window-mode-control__error\s*\{[^}]*display:\s*grid;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
  });

  /**
   * Карточка смены на реальном терминале разошлась с принятым макетом сразу в
   * нескольких мелочах, и каждая из них — одна строка CSS, которую легко
   * потерять обратно.
   */
  it("keeps the shift card's approved geometry: air between the facts, soft tags, a framed studio photo", () => {
    const css = stationSource("station.css");
    // 4px между заголовком, датами и тегами склеивали их в одно пятно.
    expect(css).toMatch(/\.shift-card__details\s*\{[^}]*gap:\s*var\(--sp-2\);/s);
    // Две даты переносятся по строкам и не слипаются.
    expect(css).toMatch(/\.shift-card__dates\s*\{[^}]*row-gap:\s*var\(--sp-1\);/s);
    // Форма различает род тега: фаза — пилюля, категория — скруглённый
    // прямоугольник. 4px словаря на 22px читались коробкой.
    expect(css).toMatch(/\.shift-card \.mk-tag\s*\{[^}]*border-radius:\s*6px;/s);
    expect(css).toMatch(/\.shift-card \.mk-chip\s*\{[^}]*border-radius:\s*999px;/s);
    // Номер смены — текст, а не тег: у него своё правило, а не .mk-tag.
    expect(css).toMatch(/\.shift-card__number\s*\{[^}]*font:[^;]*var\(--font-mono\);/s);
    // Снимок со своей подложкой обнимается коробкой, иначе скругление режет
    // пустые углы `contain`, а не углы картинки.
    expect(css).toMatch(
      /\.shift-card__photo\[data-photo="opaque"\] \.product-image\s*\{[^}]*width:\s*auto;[^}]*height:\s*auto;[^}]*max-width:\s*100%;[^}]*max-height:\s*100%;[^}]*border-radius:/s,
    );
    // Заголовок без полного имени занимает его строки.
    expect(css).toMatch(/\.shift-card__product--only\s*\{[^}]*-webkit-line-clamp:\s*5;/s);
    expect(css).toMatch(
      /@media \(max-height: 820px\)\s*\{[\s\S]*?\.shift-card__product--only\s*\{[^}]*-webkit-line-clamp:\s*4;/s,
    );
  });
});
