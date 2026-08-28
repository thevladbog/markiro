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

  it("caps the detail page content width", () => {
    expect(css).toMatch(/\.mk-inventory-page\s*\{[^}]*max-width:\s*1200px;/s);
  });
});
