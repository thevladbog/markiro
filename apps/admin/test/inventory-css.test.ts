import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../src/pages/inventory/inventory.css"), "utf8");

describe("inventory.css contracts", () => {
  it("stacks step/upload/terminal captions as a flex column", () => {
    expect(css).toMatch(
      /\.mk-inventory-steps li > span:last-child,[^{]+\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
  });

  it("keeps the terminal-line chip on one line", () => {
    expect(css).toMatch(
      /\.mk-inventory-terminal-line > \.mk-chip\s*\{[^}]*flex-direction:\s*row;[^}]*flex-shrink:\s*0;[^}]*white-space:\s*nowrap;/s,
    );
  });

  it("guards every StatusChip in the inventory page from column stacking", () => {
    expect(css).toMatch(
      /\.mk-inventory-page \.mk-chip\s*\{[^}]*flex-direction:\s*row;[^}]*flex-shrink:\s*0;/s,
    );
  });

  it("gives the terminals step vertical breathing room between its blocks", () => {
    expect(css).toMatch(
      /\.mk-inventory-terminals\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*14px;/s,
    );
  });

  it("keeps every correction action caption on a single line", () => {
    // Regression: the action buttons are flex items, so a narrow box column
    // shrank them below their caption and «Поставить перепечать в очередь»
    // wrapped onto a second line that spilled out of the 32px button box.
    expect(css).toMatch(
      /\.mk-inventory-correction-list__actions \.mk-btn\s*\{[^}]*white-space:\s*nowrap;/s,
    );
  });

  it("reserves room for the widest box action beside the corrections list", () => {
    expect(css).toMatch(
      /\.mk-inventory-correction-layout--repack\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*3fr\)\s*minmax\(300px,\s*2fr\);/s,
    );
  });

  it("never breaks an SSCC mid-number", () => {
    // `.mk-inventory-mono` opts every identity into `overflow-wrap: anywhere`
    // for the 69-character fallback identity; an 18-digit SSCC must opt back
    // out or it splits between two digits.
    expect(css).toMatch(/\.mk-inventory-mono--sscc\s*\{[^}]*overflow-wrap:\s*normal;/s);
  });

  it("leaves the content width to the shell rail on every inventory step", () => {
    // Regression: a page-level cap made the inventory routes render a second,
    // narrower rail than the rest of the admin on wide screens.
    expect(css).toMatch(/\.mk-inventory-page\s*\{[^}]*min-width:\s*0;[^}]*\}/s);
    // Only `@media (max-width: ...)` preludes may mention it -- no declaration.
    expect(css).not.toMatch(/^\s*max-width:/m);
  });
});
