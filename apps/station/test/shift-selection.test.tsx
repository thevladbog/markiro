import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import { ShiftSelection } from "../src/pages/ShiftSelection.js";

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => vi.restoreAllMocks());

const client = createStationClient({ machineId: "m1", apiKey: "k", serverUrl: "http://localhost:3000" });

describe("ShiftSelection", () => {
  it("opens a planned shift and calls onSelected with the opened shift", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [
        { id: "s1", status: "planned", mode: "validation", productName: "Cola", plannedQty: 100 },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "s1", status: "active", mode: "validation" }), { status: 200 }));

    const onSelected = vi.fn();
    render(<ShiftSelection client={client} onSelected={onSelected} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(onSelected).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", status: "active" })));
  });

  it("surfaces an error and does not call onSelected when opening a shift fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [
        { id: "s1", status: "planned", mode: "validation", productName: "Cola", plannedQty: 100 },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Shift already closed" }), { status: 422 }));

    const onSelected = vi.fn();
    render(<ShiftSelection client={client} onSelected={onSelected} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(screen.getByText("Shift already closed")).toBeDefined());
    expect(onSelected).not.toHaveBeenCalled();
  });
});
