import { describe, expect, it } from "vitest";
import { createKeyboardWedgeSource } from "../src/lib/scan-source.js";

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}

describe("keyboard wedge scan source", () => {
  it("emits the accumulated payload on Enter", () => {
    const scans: string[] = [];
    const stop = createKeyboardWedgeSource().start((raw) => scans.push(raw));

    for (const ch of "0104600000000015") press(ch);
    press("Enter");

    expect(scans).toEqual(["0104600000000015"]);
    stop();
  });

  it("starts a fresh payload after each Enter", () => {
    const scans: string[] = [];
    const stop = createKeyboardWedgeSource().start((raw) => scans.push(raw));

    press("A");
    press("Enter");
    press("B");
    press("Enter");

    expect(scans).toEqual(["A", "B"]);
    stop();
  });

  it("ignores modifier and navigation keys", () => {
    const scans: string[] = [];
    const stop = createKeyboardWedgeSource().start((raw) => scans.push(raw));

    press("Shift");
    press("ArrowLeft");
    press("7");
    press("Enter");

    expect(scans).toEqual(["7"]);
    stop();
  });

  it("does not emit an empty payload", () => {
    const scans: string[] = [];
    const stop = createKeyboardWedgeSource().start((raw) => scans.push(raw));
    press("Enter");
    expect(scans).toEqual([]);
    stop();
  });

  it("stops listening once stopped", () => {
    const scans: string[] = [];
    const stop = createKeyboardWedgeSource().start((raw) => scans.push(raw));
    stop();
    press("9");
    press("Enter");
    expect(scans).toEqual([]);
  });
});
