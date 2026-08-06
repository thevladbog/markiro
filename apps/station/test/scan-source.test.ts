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

  it("can discard manual text buffered before the next badge scan", () => {
    const scans: string[] = [];
    const source = createKeyboardWedgeSource();
    const stop = source.start((raw) => scans.push(raw));

    for (const ch of "name") press(ch);
    source.clearPendingInput?.();
    for (const ch of "BADGE") press(ch);
    press("Enter");

    expect(scans).toEqual(["BADGE"]);
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

  it("prevents the default action on the terminating Enter", () => {
    // A wedge scanner types into whatever element happens to hold DOM focus.
    // If a focused native <button> is left free to run its own Enter-activates
    // default action, the terminating Enter of a scan would ALSO fire a click
    // on that button. `dispatchEvent` returns false when some listener called
    // `preventDefault()` on a cancelable event, so this is a direct check that
    // the wedge suppresses that default action rather than only reading data.
    const scans: string[] = [];
    const stop = createKeyboardWedgeSource().start((raw) => scans.push(raw));

    for (const ch of "42") press(ch);
    const enterEvent = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    const notPrevented = window.dispatchEvent(enterEvent);

    expect(notPrevented).toBe(false);
    expect(scans).toEqual(["42"]);
    stop();
  });
});
