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

  it("leaves the content width to the shell rail on every inventory step", () => {
    // Regression: a page-level cap made the inventory routes render a second,
    // narrower rail than the rest of the admin on wide screens.
    expect(css).toMatch(/\.mk-inventory-page\s*\{[^}]*min-width:\s*0;[^}]*\}/s);
    // Only `@media (max-width: ...)` preludes may mention it -- no declaration.
    expect(css).not.toMatch(/^\s*max-width:/m);
  });
});
