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
});
