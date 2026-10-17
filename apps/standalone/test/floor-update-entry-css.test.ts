import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cssRules } from "./support/css-rules.js";

const rulesOf = (path: string) => cssRules(readFileSync(join(process.cwd(), path), "utf8"));

describe("the update entry's stylesheets", () => {
  it("never size a control below the floor's 64 px target (the buttons come from the kit)", () => {
    for (const path of [
      "src/floor/setup/station-update-block.css",
      "src/floor/sign-in/sign-in-version-footer.css",
    ]) {
      for (const rule of rulesOf(path)) {
        const heights = [...rule.body.matchAll(/(?:min-)?height:\s*(\d+)px/g)];
        for (const match of heights) expect(Number(match[1])).toBeGreaterThanOrEqual(64);
      }
    }
  });

  it("puts the version block over the unpairing in the right column, and stacks them on a narrow window", () => {
    const rules = rulesOf("src/floor/setup/station-update-block.css");
    expect(
      rules.some(
        (r) => r.selector.includes(".setup-station__update") && /grid-column:\s*2/.test(r.body),
      ),
    ).toBe(true);
    expect(rules.some((r) => r.within.length > 0 && /grid-column:\s*1/.test(r.body))).toBe(true);
  });

  it("gives the sign-in a fifth row only where the footer is drawn", () => {
    const rules = rulesOf("src/floor/sign-in/sign-in-version-footer.css");
    expect(rules[0]?.selector).toContain(":has(> .sign-in-version)");
  });
});
