import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createKeyboardWedgeSource,
  type ScanListener,
  type ScanSource,
} from "../src/floor/scan-source.js";
import { listenOfficeScans } from "../src/office/search/office-scan.js";

describe("Office global scan ownership", () => {
  it("resumes COM delivery after dirty state clears without a focus or key event", () => {
    let manual = false;
    let listener: ScanListener = () => undefined;
    const source: ScanSource = {
      start: (next) => {
        listener = next;
        return () => undefined;
      },
      clearPendingInput: () => undefined,
      setManualTextEntryActive: (next) => {
        manual = next;
      },
    };
    let dirty = true;
    const onScan = vi.fn();
    const stop = listenOfficeScans(source, onScan, () => dirty);
    const emit = () => {
      if (!manual) listener("COM scan");
    };
    emit();
    expect(onScan).not.toHaveBeenCalled();
    dirty = false;
    emit();
    expect(onScan).toHaveBeenCalledExactlyOnceWith("COM scan");
    stop();
  });
  it("does not consume text fields or their Enter, then resumes on the page", () => {
    const onScan = vi.fn();
    const stop = listenOfficeScans(createKeyboardWedgeSource(), onScan);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    for (const key of "typed") fireEvent.keyDown(input, { key });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(onScan).not.toHaveBeenCalled();
    input.blur();
    for (const key of "scanned") fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onScan).toHaveBeenCalledExactlyOnceWith("scanned");
    stop();
    input.remove();
  });

  it("refuses COM callbacks during any modal, while dirty, and after unmount", () => {
    let listener: ScanListener = () => undefined;
    const source: ScanSource = {
      start: (next) => {
        listener = next;
        return vi.fn();
      },
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
    let dirty = false;
    const onScan = vi.fn();
    const stop = listenOfficeScans(source, onScan, () => dirty);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    listener("modal");
    dialog.remove();
    dirty = true;
    listener("dirty");
    dirty = false;
    listener("free");
    stop();
    listener("late");
    expect(onScan).toHaveBeenCalledExactlyOnceWith("free");
  });
});
