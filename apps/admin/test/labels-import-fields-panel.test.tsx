import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportFieldsPanel } from "../src/pages/labels/editor/ImportFieldsPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImportFieldsPanel", () => {
  it("shows {{placeholders}} for code and bare field ids for JSON, copying exactly what it shows", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { rerender } = render(<ImportFieldsPanel syntax="placeholder" />);
    expect(screen.getByRole("complementary", { name: "Шаблонные поля" })).toBeDefined();
    expect(screen.getByText("{{product.printName}}")).toBeDefined();
    expect(screen.getByText("Вставьте плейсхолдер целиком в текст или штрихкод.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Копировать {{product.printName}}" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("{{product.printName}}"));
    expect(await screen.findByRole("status")).toBeDefined();

    rerender(<ImportFieldsPanel syntax="json" />);
    expect(screen.queryByText("{{product.printName}}")).toBeNull();
    expect(screen.getByText("product.printName")).toBeDefined();
    expect(
      screen.getByText("Подставьте как значение field у текста или data у штрихкода."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Копировать product.printName" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("product.printName"));
  });

  it("reports a clipboard failure instead of pretending the copy happened", async () => {
    vi.stubGlobal("navigator", {});
    render(<ImportFieldsPanel syntax="json" />);
    fireEvent.click(screen.getByRole("button", { name: "Копировать sscc" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears a stale success status when a later copy in the same session fails", async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ImportFieldsPanel syntax="json" />);

    fireEvent.click(screen.getByRole("button", { name: "Копировать sscc" }));
    expect(await screen.findByRole("status")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Копировать date" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    // The earlier success message must not linger next to the new failure --
    // it would misrepresent the LATEST copy attempt as having succeeded.
    expect(screen.queryByRole("status")).toBeNull();
  });
});
