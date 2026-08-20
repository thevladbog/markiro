import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { ShiftSelection } from "../src/pages/ShiftSelection.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const client = createStationClient({
  machineId: "m1",
  apiKey: "k",
  serverUrl: "http://localhost:3000",
});

describe("ShiftSelection", () => {
  it("hides a locally closed shift while the server still reports it active", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "just-closed",
              status: "active",
              mode: "aggregation",
              productName: "Waiting for close sync",
              plannedQty: 10,
              productId: "product-1",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const exec: SqlExecutor = {
      async run() {},
      async all<T>() {
        return [{ id: "just-closed" }] as T[];
      },
    };

    render(<ShiftSelection client={client} exec={exec} onSelected={() => {}} onNew={() => {}} />);

    await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());
    expect(screen.queryByText("Waiting for close sync")).toBeNull();
  });

  it("refreshes an open empty list and shows a shift created in the cabinet", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "cabinet-shift",
                status: "planned",
                mode: "validation",
                productName: "Created in cabinet",
                plannedQty: 100,
                productId: "product-created-in-cabinet",
              },
            ],
          }),
          { status: 200 },
        ),
      );

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);
    await act(async () => {});
    expect(screen.getByText("No open shifts")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByRole("button", { name: "Open" })).toBeDefined();
    vi.useRealTimers();
  });

  it("lets the operator refresh an empty shift list immediately", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "cabinet-shift",
                status: "planned",
                mode: "validation",
                productName: "Available now",
                number: "AUG26-001",
                plannedQty: 100,
                productId: "product-available-now",
              },
            ],
          }),
          { status: 200 },
        ),
      );

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Refresh shifts" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).toBeDefined());
    expect(await screen.findByText(/AUG26-001/)).toBeDefined();
  });

  it("keeps the empty screen static across a background poll", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);
    await act(async () => {});

    const refresh = () => screen.getByRole("button", { name: "Refresh shifts" });
    // The centred empty state carries no control the poll could toggle, and the
    // footer control never reacts to a refresh the operator did not ask for.
    expect(screen.getByText("No open shifts")).toBeDefined();
    expect(refresh().closest(".shift-selection__state")).toBeNull();
    expect((refresh() as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect((refresh() as HTMLButtonElement).disabled).toBe(false);
    vi.useRealTimers();
  });

  it("keeps a loaded shift selectable after a background refresh fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "planned-shift",
                status: "planned",
                mode: "validation",
                productName: "Still available",
                plannedQty: 100,
                productId: "product-still-available",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "planned-shift", status: "active", mode: "validation" }),
          {
            status: 200,
          },
        ),
      );
    const onSelected = vi.fn();

    render(<ShiftSelection client={client} onSelected={onSelected} onNew={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Open" })).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByText("Could not load shifts. Check server access.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(onSelected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "planned-shift", status: "active" }),
    );
  });

  it("coalesces repeated empty-list refreshes while the prior request is pending", async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockReturnValueOnce(pendingRefresh);

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());

    const refresh = screen.getByRole("button", { name: "Refresh shifts" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((refresh as HTMLButtonElement).disabled).toBe(true);

    resolveRefresh?.(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  });

  it("does not start an interval refresh while the initial list request is pending", async () => {
    vi.useFakeTimers();
    let resolveInitial: ((response: Response) => void) | undefined;
    const pendingInitial = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingInitial);

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(fetchMock).toHaveBeenCalledOnce();

    resolveInitial?.(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await act(async () => {});
  });

  it("renders a bounded two-card page after filtering closed shifts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            { id: "closed", status: "closed", mode: "validation", productName: "Closed" },
            { id: "s1", status: "active", mode: "validation", productName: "One" },
            { id: "s2", status: "planned", mode: "validation", productName: "Two" },
            { id: "s3", status: "planned", mode: "aggregation", productName: "Three" },
            { id: "s4", status: "planned", mode: "validation", productName: "Four" },
          ],
        }),
        { status: 200 },
      ),
    );

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);

    await waitFor(() => expect(screen.getByText("One")).toBeDefined());
    expect(screen.queryByText("Closed")).toBeNull();
    expect(screen.getByText("Two")).toBeDefined();
    expect(screen.queryByText("Three")).toBeNull();
    expect(screen.queryByText("Four")).toBeNull();
    expect(screen.getByText("Page 1 of 2")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.queryByText("One")).toBeNull();
    expect(screen.getByText("Three")).toBeDefined();
    expect(screen.getByText("Four")).toBeDefined();
    expect(screen.getByText("Page 2 of 2")).toBeDefined();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("keeps the clamped page after a shrinking dataset grows again", async () => {
    const fourItems = Array.from({ length: 4 }, (_, index) => ({
      id: `s${index + 1}`,
      status: "planned",
      mode: "validation",
      productName: `Product ${index + 1}`,
      plannedQty: null,
    }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: fourItems }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: fourItems.slice(0, 1) }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: fourItems }), { status: 200 }));
    const secondClient = createStationClient({
      machineId: "m1",
      apiKey: "k",
      serverUrl: "http://localhost:3001",
    });
    const thirdClient = createStationClient({
      machineId: "m1",
      apiKey: "k",
      serverUrl: "http://localhost:3002",
    });

    const view = render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 2 of 2")).toBeDefined();

    view.rerender(<ShiftSelection client={secondClient} onSelected={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Page 1 of 1")).toBeDefined());

    view.rerender(<ShiftSelection client={thirdClient} onSelected={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeDefined());
    expect(screen.getByText("Product 1")).toBeDefined();
    expect(screen.queryByText("Product 4")).toBeNull();
  });

  it("shows a recoverable server-access alert after a transport failure without removing floor actions", async () => {
    let rejectList!: (reason: unknown) => void;
    const pendingList = new Promise<Response>((_resolve, reject) => {
      rejectList = reject;
    });
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(pendingList)
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    render(
      <ShiftSelection
        client={client}
        onSelected={() => {}}
        onNew={() => {}}
        onSetup={() => {}}
        onConflicts={() => {}}
      />,
    );
    expect(screen.getByText("Loading shifts…")).toBeDefined();

    rejectList(new TypeError("Failed to fetch"));
    await waitFor(() =>
      expect(screen.getByText("Could not load shifts. Check server access.")).toBeDefined(),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDefined());
    expect(screen.getByRole("button", { name: "New shift" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Workstation setup" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Conflicts" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());
  });

  it("keeps a safe server message when loading shifts receives an API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Shift list access is restricted" }), { status: 403 }),
    );

    render(<ShiftSelection client={client} onSelected={() => {}} onNew={() => {}} />);

    await waitFor(() => expect(screen.getByText("Shift list access is restricted")).toBeDefined());
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("keeps new-shift, setup, and conflict actions available in the fixed footer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const onNew = vi.fn();
    const onSetup = vi.fn();
    const onConflicts = vi.fn();

    render(
      <ShiftSelection
        client={client}
        onSelected={() => {}}
        onNew={onNew}
        onSetup={onSetup}
        onConflicts={onConflicts}
      />,
    );
    await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());

    const footer = screen.getByRole("contentinfo", { name: "Shift actions" });
    expect(footer).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "New shift" }));
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(onSetup).toHaveBeenCalledOnce();
    expect(onConflicts).toHaveBeenCalledOnce();
  });

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

  it("rejoins an active shift without posting an open request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "s1",
              status: "active",
              mode: "aggregation",
              productName: "Cola",
              plannedQty: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const onSelected = vi.fn();

    render(<ShiftSelection client={client} onSelected={onSelected} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Rejoin" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));

    expect(onSelected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", status: "active", mode: "aggregation" }),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
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

  it("ignores an old open response after cleanup and a replacement floor mounts", async () => {
    let resolveOpen!: (response: Response) => void;
    const pendingOpen = new Promise<Response>((resolve) => {
      resolveOpen = resolve;
    });
    const list = new Response(
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
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(list)
      .mockReturnValueOnce(pendingOpen)
      .mockResolvedValueOnce(list.clone());
    const oldSelected = vi.fn();
    const oldFloor = render(
      <ShiftSelection
        client={client}
        onSelected={oldSelected}
        onNew={() => {}}
        isCurrent={() => false}
      />,
    );
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    // The request began while current; credential recovery happens while it
    // is in flight and unmounts the authenticated floor.
    oldFloor.rerender(
      <ShiftSelection
        client={client}
        onSelected={oldSelected}
        onNew={() => {}}
        isCurrent={() => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    oldFloor.unmount();

    const freshSelected = vi.fn();
    render(
      <ShiftSelection
        client={client}
        onSelected={freshSelected}
        onNew={() => {}}
        isCurrent={() => true}
      />,
    );
    resolveOpen(new Response(JSON.stringify({ id: "s1", status: "active", mode: "validation" })));
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());

    expect(oldSelected).not.toHaveBeenCalled();
    expect(freshSelected).not.toHaveBeenCalled();
  });
});
