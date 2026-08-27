import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilePickerButton } from "../src/pages/inventory/FilePickerButton.js";

describe("FilePickerButton", () => {
  it("opens the hidden input and forwards the picked file", () => {
    const onFile = vi.fn();
    render(
      <FilePickerButton label="Выбрать файл" busyLabel="Загрузка…" accept=".csv" onFile={onFile} />,
    );
    const input = screen.getByTestId("file-picker-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.className).toContain("mk-file-picker__input");
    const file = new File(["a"], "chz.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "Выбрать файл" })).toBeDefined();
  });
});
