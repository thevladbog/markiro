import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import { ShiftSelection } from "../src/pages/ShiftSelection.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());

const client = createStationClient({
  machineId: "m1",
  apiKey: "k",
  serverUrl: "http://localhost:3000",
});

describe("ShiftSelection", () => {
  it("renders the counterparty label through i18n, not a hard-coded Russian string (regression for M8)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "s1",
              status: "planned",
              mode: "validation",
              productName: "Cola",
              plannedQty: 100,
              counterpartyName: "Buyer Co",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("for: Buyer Co")).toBeDefined());
  });

  it("opens a planned shift and calls onSelected with the opened shift", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "s1",
                status: "planned",
                mode: "validation",
                productName: "Cola",
                plannedQty: 100,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s1", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );

    const onSelected = vi.fn();
    render(<ShiftSelection client={client} onSelected={onSelected} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(onSelected).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1", status: "active" }),
      ),
    );
  });

  // Finding 3: while `open()` is in flight, the Conflicts button must not
  // stay clickable. `onSelected` fires whenever that request resolves --
  // whether or not the operator has since navigated away -- so pressing
  // Conflicts mid-open and then Back could drop them into a shift they
  // never chose to enter.
  it("disables the Conflicts button while a shift open is in flight", async () => {
    let resolveOpen!: (r: Response) => void;
    const openPending = new Promise<Response>((resolve) => {
      resolveOpen = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "s1",
                status: "planned",
                mode: "validation",
                productName: "Cola",
                plannedQty: 100,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockReturnValueOnce(openPending);

    const onConflicts = vi.fn();
    render(
      <ShiftSelection
        client={client}
        onSelected={() => {}}
        onNew={() => {}}
        onConflicts={onConflicts}
      />,
    );
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    const conflictsButton = () =>
      screen.getByRole("button", { name: "Conflicts" }) as HTMLButtonElement;
    expect(conflictsButton().disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(conflictsButton().disabled).toBe(true));

    fireEvent.click(conflictsButton());
    expect(onConflicts).not.toHaveBeenCalled();

    resolveOpen(new Response(JSON.stringify({ id: "s1", status: "active", mode: "validation" })));
    await waitFor(() => expect(conflictsButton().disabled).toBe(false));
  });

  it("surfaces an error and does not call onSelected when opening a shift fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "s1",
                status: "planned",
                mode: "validation",
                productName: "Cola",
                plannedQty: 100,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Shift already closed" }), { status: 422 }),
      );

    const onSelected = vi.fn();
    render(<ShiftSelection client={client} onSelected={onSelected} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(screen.getByText("Shift already closed")).toBeDefined());
    expect(onSelected).not.toHaveBeenCalled();
  });
});
