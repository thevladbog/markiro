import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KIT_SCOPE_CLASS, useKitScope } from "../src/office/kit-scope.js";

function Screen() {
  useKitScope();
  return null;
}

describe("the 2026 sizing scope", () => {
  it("is on <html> while an office screen is mounted and gone after", () => {
    expect(document.documentElement.classList.contains(KIT_SCOPE_CLASS)).toBe(false);
    const view = render(<Screen />);
    expect(document.documentElement.classList.contains(KIT_SCOPE_CLASS)).toBe(true);
    view.unmount();
    expect(document.documentElement.classList.contains(KIT_SCOPE_CLASS)).toBe(false);
  });

  it("stays while one of two screens is left (the login handing over to the office)", () => {
    const login = render(<Screen />);
    const office = render(<Screen />);
    login.unmount();
    expect(document.documentElement.classList.contains(KIT_SCOPE_CLASS)).toBe(true);
    office.unmount();
    expect(document.documentElement.classList.contains(KIT_SCOPE_CLASS)).toBe(false);
  });
});

describe("the office stylesheets", () => {
  /** The one rule that still fights an inline style: the pairing card's radio group, outside the office. */
  const ALLOWED = ["flex-direction: row !important", "gap: 24px !important"];
  it.each(["src/app/shell.css", "src/office/list/list.css"])(
    "%s draws buttons and fields through the kit's hooks, not !important",
    (file) => {
      const css = readFileSync(join(__dirname, "..", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => line.includes("!important"))
        .map((line) => line.trim())
        .filter((line) => !ALLOWED.includes(line.replace(/;$/, "")));
      expect(css).toEqual([]);
    },
  );
});
