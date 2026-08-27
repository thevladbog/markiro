import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileDropZone } from "@markiro/ui";

afterEach(() => {
  cleanup();
});

describe("FileDropZone", () => {
  it("does not throw when the zone is clicked", () => {
    render(<FileDropZone label="Перетащите файл или нажмите" accept=".csv" onFile={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByRole("button"))).not.toThrow();
  });

  it("forwards a file picked through the hidden input and resets its value", () => {
    const onFile = vi.fn();
    render(<FileDropZone label="Перетащите файл или нажмите" accept=".csv" onFile={onFile} />);
    const input = screen.getByTestId("file-drop-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    const file = new File(["a"], "report.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("forwards a dropped file", () => {
    const onFile = vi.fn();
    render(<FileDropZone label="Перетащите файл или нажмите" accept=".csv" onFile={onFile} />);
    const zone = screen.getByRole("button");
    const file = new File(["a"], "report.csv", { type: "text/csv" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("ignores a dropped file while disabled", () => {
    const onFile = vi.fn();
    render(
      <FileDropZone label="Перетащите файл или нажмите" accept=".csv" disabled onFile={onFile} />,
    );
    const zone = screen.getByRole("button");
    const file = new File(["a"], "report.csv", { type: "text/csv" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFile).not.toHaveBeenCalled();
  });

  it("applies ariaLabel as the zone's accessible name", () => {
    render(
      <FileDropZone
        label="Перетащите файл или нажмите"
        ariaLabel="Выбрать файл INTRODUCED"
        accept=".csv"
        onFile={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Выбрать файл INTRODUCED" })).toBeDefined();
  });
});
