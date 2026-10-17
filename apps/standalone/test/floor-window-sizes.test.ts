import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The sign-in and the re-confirmation are one markup at every window size; only CSS answers the
 * size (owner report, beta 4.5: the windowed state kept the old look). The measured proof is
 * `test/harness/window-mode/measure.mjs`; these keep its rules from being dropped unnoticed.
 */
const css = (path: string) => readFileSync(join(__dirname, "..", "src/floor", path), "utf8");

describe("the floor's sign-in and re-confirmation across window sizes", () => {
  const signIn = css("sign-in/operator-sign-in.css");
  const reconfirm = css("reconfirm.css");

  it("keeps the panel's width, centred, in a wide window", () => {
    expect(signIn).toMatch(
      /\.operator-login\s*\{\s*padding-inline:\s*max\(var\(--sp-5\),\s*calc\(\(100% - 1280px\) \/ 2\)\);\s*\}/,
    );
    // The card is a fixed width in the middle, never the width of the window.
    expect(reconfirm).toMatch(/\.reconfirm-card\s*\{[^}]*width:\s*min\(720px,\s*100%\)/);
    expect(reconfirm).toMatch(/data-stage="entry"\]\s*\{\s*width:\s*min\(980px,\s*100%\)/);
    expect(reconfirm).toMatch(/\.reconfirm-overlay\s*\{[^}]*place-items:\s*center/);
  });

  it("has a step for a low window that never goes under the floor's 64 px", () => {
    for (const source of [signIn, reconfirm]) {
      const step = /@media \(max-height: 640px\) \{([\s\S]*?)\n\}\n/.exec(source)?.[1] ?? "";
      expect(step).not.toBe("");
      const heights = [...step.matchAll(/(?:height|min-height):\s*(\d+)px/g)].map((m) =>
        Number(m[1]),
      );
      expect(heights.length).toBeGreaterThan(0);
      // 22 px and 24 px are the lines under a field, not controls.
      for (const px of heights.filter((px) => px >= 40 && px < 64)) {
        expect(px, "a control under 64 px in the low-window step").toBeGreaterThanOrEqual(64);
      }
    }
  });

  it("does not key either screen to a window state", () => {
    for (const source of [signIn, reconfirm]) {
      expect(source).not.toMatch(/data-window|data-kiosk|\.windowed|\.kiosk/);
    }
  });
});
