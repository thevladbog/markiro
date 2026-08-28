import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileDropZone, fileMatchesAccept } from "../src/index.js";

afterEach(() => {
  cleanup();
});

describe("fileMatchesAccept", () => {
  it("matches an extension pattern case-insensitively", () => {
    expect(fileMatchesAccept({ name: "data.CSV", type: "" }, ".csv")).toBe(true);
  });

  it("matches a universal MIME pattern by prefix", () => {
    expect(fileMatchesAccept({ name: "photo.png", type: "image/png" }, "image/*")).toBe(true);
  });

  it("rejects a file matching neither the extension nor the MIME type", () => {
    expect(fileMatchesAccept({ name: "report.pdf", type: "application/pdf" }, ".csv")).toBe(false);
  });
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

  it("ignores a picked file that does not match accept", () => {
    const onFile = vi.fn();
    render(<FileDropZone label="Перетащите файл или нажмите" accept=".csv" onFile={onFile} />);
    const input = screen.getByTestId("file-drop-input") as HTMLInputElement;
    const file = new File(["a"], "malware.exe", { type: "application/octet-stream" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("hands a non-matching file to onRejected instead of onFile", () => {
    const onFile = vi.fn();
    const onRejected = vi.fn();
    render(
      <FileDropZone
        label="Перетащите файл или нажмите"
        accept=".csv"
        onFile={onFile}
        onRejected={onRejected}
      />,
    );
    const file = new File(["a"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("file-drop-input"), { target: { files: [file] } });
    fireEvent.drop(screen.getByRole("button"), { dataTransfer: { files: [file] } });
    expect(onFile).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(2);
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

  it("ignores a dropped file that does not match accept", () => {
    const onFile = vi.fn();
    render(<FileDropZone label="Перетащите файл или нажмите" accept=".csv" onFile={onFile} />);
    const zone = screen.getByRole("button");
    const file = new File(["a"], "photo.png", { type: "image/png" });
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
