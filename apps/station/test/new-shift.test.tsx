import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { NewShift } from "../src/pages/NewShift.js";
import { useTimeZone } from "./support/timezone.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const client = createStationClient({
  machineId: "m1",
  apiKey: "k",
  serverUrl: "http://localhost:3000",
});
const resolvedProduct = {
  id: "p1",
  gtin14: "04600000000015",
  name: "Cola",
  status: "active",
  boxCapacity: null,
};
const silentSource: ScanSource = { start: () => () => {} };
const templateLibrary = {
  items: [
    { id: "tpl-default", name: "Box 58x40", widthMm: 58, heightMm: 40, dpi: 203, language: "zpl" },
    {
      id: "tpl-alt",
      name: "Euro pallet 100x80",
      widthMm: 100,
      heightMm: 80,
      dpi: 300,
      language: "tspl",
    },
  ],
  defaultBoxLabelTemplateId: "tpl-default",
};

function deferredResponse() {
  let settle: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function expectButtonDisabled(button: HTMLElement, disabled: boolean) {
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) throw new Error("expected a button element");
  expect(button.disabled).toBe(disabled);
}

function entryLease(order: string[] = []) {
  let current = true;
  const release = vi.fn(() => {
    if (!current) return;
    current = false;
    order.push("release");
  });
  return {
    lease: { isCurrent: () => current, release },
    release,
  };
}

function submitGtin() {
  const input = screen.getByLabelText("Type or scan a GTIN");
  fireEvent.change(input, { target: { value: "4600000000015" } });
  const form = input.closest("form");
  expect(form).not.toBeNull();
  if (!form) throw new Error("new shift GTIN form is missing");
  fireEvent.submit(form);
}

function manualScanSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    },
  };
  return {
    source,
    scan(raw: string) {
      listener?.(raw);
    },
  };
}

describe("NewShift", () => {
  it("fills and resolves the product from an EAN-13 scanner event", async () => {
    const gtinCheck = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => gtinCheck.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      );
    const scanner = manualScanSource();
    render(
      <NewShift client={client} source={scanner.source} onStarted={vi.fn()} onBack={() => {}} />,
    );

    act(() => scanner.scan("4600000000015"));

    const input = screen.getByLabelText("Type or scan a GTIN");
    expect(input).toBeInstanceOf(HTMLInputElement);
    if (!(input instanceof HTMLInputElement)) throw new Error("expected a GTIN input");
    expect(input.value).toBe("04600000000015");

    await act(async () => {
      gtinCheck.resolve(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
          status: 200,
        }),
      );
    });
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
  });

  it("extracts the product GTIN from a DataMatrix scanner event", async () => {
    const gtinCheck = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => gtinCheck.promise)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "p2",
                gtin14: "04600682000013",
                name: "Marked tea",
                status: "active",
                boxCapacity: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const scanner = manualScanSource();
    render(
      <NewShift client={client} source={scanner.source} onStarted={vi.fn()} onBack={() => {}} />,
    );

    act(() => scanner.scan("010460068200001321abcDEF1234567"));

    const input = screen.getByLabelText("Type or scan a GTIN");
    expect(input).toBeInstanceOf(HTMLInputElement);
    if (!(input instanceof HTMLInputElement)) throw new Error("expected a GTIN input");
    expect(input.value).toBe("04600682000013");

    await act(async () => {
      gtinCheck.resolve(
        new Response(JSON.stringify({ gtin14: "04600682000013", owner: "own" }), {
          status: 200,
        }),
      );
    });
    await waitFor(() => expect(screen.getByText("Marked tea")).toBeDefined());
  });

  it("returns from the initial GTIN screen to shift selection", () => {
    const onBack = vi.fn();
    render(<NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("returns from the resolved-product screen to shift selection", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [resolvedProduct],
          }),
          { status: 200 },
        ),
      );
    const onBack = vi.fn();
    render(<NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={onBack} />);
    submitGtin();
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps Back disabled while GTIN resolution is pending", async () => {
    const gtinCheck = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => gtinCheck.promise)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [resolvedProduct],
          }),
          { status: 200 },
        ),
      );
    const onBack = vi.fn();
    render(<NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={onBack} />);
    submitGtin();

    const pendingBack = screen.getByRole("button", { name: "Back" });
    await waitFor(() => expectButtonDisabled(pendingBack, true));
    fireEvent.click(pendingBack);
    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      gtinCheck.resolve(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
          status: 200,
        }),
      );
    });
    const idleBack = await screen.findByRole("button", { name: "Back" });
    await waitFor(() => expectButtonDisabled(idleBack, false));
    fireEvent.click(idleBack);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps Back and the lease held through cancellation, create, and open", async () => {
    const createShift = deferredResponse();
    const openShift = deferredResponse();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [resolvedProduct],
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => createShift.promise)
      .mockImplementationOnce(() => openShift.promise);
    const onBack = vi.fn();
    let releaseEntry!: () => void;
    const entryBarrier = new Promise<void>((resolve) => {
      releaseEntry = resolve;
    });
    const order: string[] = [];
    const owned = entryLease(order);
    const acquireShiftEntry = vi.fn(async () => {
      await entryBarrier;
      return owned.lease;
    });
    const onStarted = vi.fn((_shift, lease) => {
      expect(lease).toBe(owned.lease);
      order.push("publish");
    });
    render(
      <NewShift
        client={client}
        source={silentSource}
        acquireShiftEntry={acquireShiftEntry}
        onStarted={onStarted}
        onBack={onBack}
      />,
    );
    submitGtin();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    const pendingBack = screen.getByRole("button", { name: "Back" });
    await waitFor(() => expectButtonDisabled(pendingBack, true));
    fireEvent.click(pendingBack);
    expect(onBack).not.toHaveBeenCalled();
    expect(acquireShiftEntry).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(onStarted).not.toHaveBeenCalled();
    expectButtonDisabled(pendingBack, true);
    releaseEntry();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    expect(owned.release).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expectButtonDisabled(pendingBack, true);

    createShift.resolve(
      new Response(JSON.stringify({ id: "s9", status: "planned", mode: "validation" }), {
        status: 201,
      }),
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));
    expect(owned.release).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expectButtonDisabled(pendingBack, true);

    openShift.resolve(
      new Response(JSON.stringify({ id: "s9", status: "active", mode: "validation" }), {
        status: 200,
      }),
    );
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(order).toEqual(["publish", "release"]);
    expect(owned.release).toHaveBeenCalledOnce();
    fireEvent.click(pendingBack);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not open or publish after a pending create retires with the route", async () => {
    const createShift = deferredResponse();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockImplementationOnce(() => createShift.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );
    const owned = entryLease();
    const onStarted = vi.fn();
    const view = render(
      <NewShift
        client={client}
        source={silentSource}
        acquireShiftEntry={async () => owned.lease}
        onStarted={onStarted}
        onBack={() => {}}
      />,
    );
    submitGtin();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    view.unmount();

    createShift.resolve(
      new Response(JSON.stringify({ id: "s9", status: "planned", mode: "validation" }), {
        status: 201,
      }),
    );
    await waitFor(() => expect(owned.release).toHaveBeenCalledOnce());

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("releases the lease once when the activation request is rejected", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "planned", mode: "validation" }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Shift already active elsewhere" }), {
          status: 409,
        }),
      );
    const owned = entryLease();
    const onStarted = vi.fn();
    render(
      <NewShift
        client={client}
        source={silentSource}
        acquireShiftEntry={async () => owned.lease}
        onStarted={onStarted}
        onBack={() => {}}
      />,
    );
    submitGtin();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByText("Action failed. Please try again.")).toBeDefined());
    expect(owned.release).toHaveBeenCalledOnce();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("renders input, found, and missing as mutually exclusive fixed state panels", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: "p1", gtin14: "04600000000015", name: "Cola", status: "active" }],
          }),
          { status: 200 },
        ),
      );

    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    expect(screen.getByTestId("new-shift-input")).toBeDefined();
    expect(screen.queryByTestId("new-shift-found")).toBeNull();
    expect(screen.queryByTestId("new-shift-missing")).toBeNull();

    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);

    await waitFor(() => expect(screen.getByTestId("new-shift-found")).toBeDefined());
    expect(screen.queryByTestId("new-shift-input")).toBeNull();
    expect(screen.queryByTestId("new-shift-missing")).toBeNull();
    expect(screen.getByTestId("new-shift-message-slot")).toBeDefined();
  });

  it("keeps validation errors in the reserved message slot", async () => {
    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), { target: { value: "123" } });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);

    await waitFor(() => expect(screen.getByText("Invalid GTIN")).toBeDefined());
    const messageSlot = screen.getByTestId("new-shift-message-slot");
    expect(messageSlot.textContent).toContain("Invalid GTIN");
  });

  // The clock is frozen on a UTC/local straddle: 21:30 UTC on the 14th is
  // already the 15th in Moscow. That pins the semantics -- a `currentLocalDate`
  // that reached for the UTC day would send "2026-08-14" and fail here -- and
  // it retires the old relative derivation, which recomputed "today" after the
  // interaction and so disagreed with the request whenever a run crossed local
  // midnight.
  it("sends a null production date and opens with an old create response that omits it", async () => {
    useTimeZone("Europe/Moscow");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-14T21:30:00.000Z"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // POST /products/gtin-check
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      // GET /products?search=... (resolve productId)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: "p1", gtin14: "04600000000015", name: "Cola", status: "active" }],
          }),
          { status: 200 },
        ),
      )
      // POST /shifts
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "planned", mode: "validation" }), {
          status: 201,
        }),
      )
      // POST /shifts/s9/open
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );

    const onStarted = vi.fn();
    render(
      <NewShift client={client} source={silentSource} onStarted={onStarted} onBack={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);

    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Validation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s9", status: "active" }),
      ),
    );

    const createRequest = fetchSpy.mock.calls[2];
    expect(createRequest?.[0]).toBe("http://localhost:3000/shifts");
    expect(JSON.parse(createRequest?.[1]?.body as string)).toEqual({
      productId: "p1",
      mode: "validation",
      plannedDate: "2026-08-15",
      productionDate: null,
    });
  });

  it("shows an optional production-date picker only after resolving a product", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      );

    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Production date" })).toBeNull();

    submitGtin();
    await screen.findByText("Cola");

    expect(screen.getByRole("button", { name: "Production date" })).toBeDefined();
    expect(screen.getByText("Optional. Use the date printed on the product.")).toBeDefined();
  });

  it("sends the selected production date and opens only after an exact create echo", async () => {
    useTimeZone("Europe/Moscow");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "s9",
            status: "planned",
            mode: "validation",
            productionDate: "2026-08-21",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );
    const onStarted = vi.fn();
    render(
      <NewShift client={client} source={silentSource} onStarted={onStarted} onBack={() => {}} />,
    );
    submitGtin();
    await screen.findByText("Cola");

    fireEvent.click(screen.getByRole("button", { name: "Production date" }));
    fireEvent.click(screen.getByRole("button", { name: "August 21, 2026" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith({ id: "s9", status: "active", mode: "validation" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toEqual({
      productId: "p1",
      mode: "validation",
      plannedDate: "2026-08-14",
      productionDate: "2026-08-21",
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost:3000/shifts/s9/open");
  });

  it.each([
    ["omits the production date", { id: "s9", status: "planned", mode: "validation" }],
    [
      "echoes a null production date",
      { id: "s9", status: "planned", mode: "validation", productionDate: null },
    ],
    [
      "echoes a different production date",
      { id: "s9", status: "planned", mode: "validation", productionDate: "2026-08-22" },
    ],
  ])(
    "keeps the product screen and does not open when the create response %s",
    async (_case, created) => {
      useTimeZone("Europe/Moscow");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));
      const onStarted = vi.fn();
      render(
        <NewShift client={client} source={silentSource} onStarted={onStarted} onBack={() => {}} />,
      );
      submitGtin();
      await screen.findByText("Cola");

      fireEvent.click(screen.getByRole("button", { name: "Production date" }));
      fireEvent.click(screen.getByRole("button", { name: "August 21, 2026" }));
      fireEvent.click(screen.getByRole("button", { name: "Start" }));

      await waitFor(() =>
        expect(
          screen.getByText(
            "The shift was not opened. Ask an administrator to remove the incomplete planned shift, update the server, then retry.",
          ),
        ).toBeDefined(),
      );
      expect(screen.getByTestId("new-shift-found")).toBeDefined();
      expect(onStarted).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls).toHaveLength(3);
    },
  );

  it("shows the blocking not-in-catalog screen for an unknown GTIN", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "unknown" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);

    await waitFor(() => expect(screen.getByText("Product is not in the catalog")).toBeDefined());
    expect(screen.getByTestId("new-shift-missing")).toBeDefined();
    expect(screen.queryByTestId("new-shift-input")).toBeNull();
    expect(screen.queryByTestId("new-shift-found")).toBeNull();
  });

  it("rejects an invalid GTIN inline", async () => {
    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), { target: { value: "123" } });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
    await waitFor(() => expect(screen.getByText("Invalid GTIN")).toBeDefined());
  });

  it("shows the generic action failure for an unknown server code, disables Start while busy, and does not call onStarted", async () => {
    let resolveCreate!: (value: Response) => void;
    const createPromise = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      // POST /products/gtin-check
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      // GET /products?search=... (resolve productId)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: "p1", gtin14: "04600000000015", name: "Cola", status: "active" }],
          }),
          { status: 200 },
        ),
      )
      // POST /shifts — a still-`draft` product rejected by the server
      .mockImplementationOnce(() => createPromise);

    const onStarted = vi.fn();
    render(
      <NewShift client={client} source={silentSource} onStarted={onStarted} onBack={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());

    const startButton = screen.getByRole("button", { name: "Start" });
    fireEvent.click(startButton);
    await waitFor(() => expect((startButton as HTMLButtonElement).disabled).toBe(true));

    resolveCreate(
      new Response(JSON.stringify({ message: "Product is not active", code: "UNKNOWN" }), {
        status: 422,
      }),
    );

    await waitFor(() => expect(screen.getByText("Action failed. Please try again.")).toBeDefined());
    expect(onStarted).not.toHaveBeenCalled();
  });

  // `plannedDate` is the station's LOCAL calendar day, so freezing the clock is
  // only half the job: 12:00 UTC is still the 14th in Moscow but already the
  // 15th in Kiritimati (UTC+14), which would fail the body assertion below.
  // Pinning the zone makes the literal date mean one thing everywhere.
  it("opens the template picker for aggregation with the org default preselected and snapshots it on start", async () => {
    useTimeZone("Europe/Moscow");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      // GET /shifts/box-label-templates
      .mockResolvedValueOnce(new Response(JSON.stringify(templateLibrary), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "planned", mode: "aggregation" }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "active", mode: "aggregation" }), {
          status: 200,
        }),
      );
    const onStarted = vi.fn();
    render(
      <NewShift client={client} source={silentSource} onStarted={onStarted} onBack={() => {}} />,
    );
    submitGtin();
    await screen.findByText("Cola");

    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByTestId("new-shift-template")).toBeDefined());
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://localhost:3000/shifts/box-label-templates?productId=p1",
    );
    expect(screen.queryByTestId("new-shift-found")).toBeNull();
    // The admin default arrives preselected and badged.
    const defaultOption = screen.getByRole("button", { name: /Box 58x40/ });
    expect(defaultOption.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Default")).toBeDefined();
    expect(screen.getByText("58×40 mm · 203 dpi")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith({ id: "s9", status: "active", mode: "aggregation" }),
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost:3000/shifts");
    expect(JSON.parse(fetchMock.mock.calls[3]?.[1]?.body as string)).toEqual({
      productId: "p1",
      mode: "aggregation",
      plannedDate: "2026-08-14",
      productionDate: null,
      boxLabelTemplateId: "tpl-default",
    });
    expect(fetchMock.mock.calls[4]?.[0]).toBe("http://localhost:3000/shifts/s9/open");
  });

  it("lets the operator switch to a different template before starting", async () => {
    useTimeZone("Europe/Moscow");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(templateLibrary), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "planned", mode: "aggregation" }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "active", mode: "aggregation" }), {
          status: 200,
        }),
      );
    const onStarted = vi.fn();
    render(
      <NewShift client={client} source={silentSource} onStarted={onStarted} onBack={() => {}} />,
    );
    submitGtin();
    await screen.findByText("Cola");
    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByTestId("new-shift-template")).toBeDefined());

    const altOption = screen.getByRole("button", { name: /Euro pallet 100x80/ });
    fireEvent.click(altOption);
    expect(altOption.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Box 58x40/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[3]?.[1]?.body as string)).toMatchObject({
      boxLabelTemplateId: "tpl-alt",
    });
  });

  it("disables Start on the template step until a template is selected when no default exists", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: templateLibrary.items, defaultBoxLabelTemplateId: null }),
          { status: 200 },
        ),
      );
    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    submitGtin();
    await screen.findByText("Cola");
    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByTestId("new-shift-template")).toBeDefined());

    expectButtonDisabled(screen.getByRole("button", { name: "Start" }), true);
    expect(screen.queryByText("Default")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Box 58x40/ }));
    expectButtonDisabled(screen.getByRole("button", { name: "Start" }), false);
  });

  it("shows guidance and blocks start when the template library is empty", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], defaultBoxLabelTemplateId: null }), {
          status: 200,
        }),
      );
    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    submitGtin();
    await screen.findByText("Cola");
    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByTestId("new-shift-template")).toBeDefined());
    expect(
      screen.getByText("No label templates in the admin panel. Create one and try again."),
    ).toBeDefined();
    expectButtonDisabled(screen.getByRole("button", { name: "Start" }), true);
  });

  it("stays on the found product with a retriable error when the template list fails to load", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response(JSON.stringify(templateLibrary), { status: 200 }));
    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    submitGtin();
    await screen.findByText("Cola");
    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    const startButton = screen.getByRole("button", { name: "Start" });
    fireEvent.click(startButton);

    await waitFor(() =>
      expect(screen.getByText("Failed to load label templates. Try again.")).toBeDefined(),
    );
    expect(screen.getByTestId("new-shift-found")).toBeDefined();
    expectButtonDisabled(startButton, false);

    fireEvent.click(startButton);
    await waitFor(() => expect(screen.getByTestId("new-shift-template")).toBeDefined());
    expect(fetchMock.mock.calls).toHaveLength(4);
  });

  it("returns from the template step to the found product without creating a shift", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(templateLibrary), { status: 200 }));
    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    submitGtin();
    await screen.findByText("Cola");
    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByTestId("new-shift-template")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("new-shift-found")).toBeDefined();
    expect(screen.queryByTestId("new-shift-template")).toBeNull();
    // Only gtin-check, product search, and the template list were requested.
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  it("renders the template step and the server safety net in Russian", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(templateLibrary), { status: 200 }))
      // Safety net: the template was deleted between listing and creation.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Aggregation shifts require a box label template",
            code: "BOX_LABEL_TEMPLATE_REQUIRED",
          }),
          { status: 422 },
        ),
      );
    render(
      <NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />,
    );
    const input = screen.getByLabelText("Введите или отсканируйте GTIN");
    fireEvent.change(input, { target: { value: "4600000000015" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("Cola");
    expect(screen.getByRole("button", { name: "Дата производства" })).toBeDefined();
    expect(screen.getByText("Необязательно. Берите с продукции.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Агрегация" }));
    fireEvent.click(screen.getByRole("button", { name: "Начать" }));
    await waitFor(() => expect(screen.getByTestId("new-shift-template")).toBeDefined());
    expect(screen.getByRole("heading", { name: "Шаблон этикетки короба" })).toBeDefined();
    expect(screen.getByText("По умолчанию")).toBeDefined();
    expect(screen.getByText("58×40 мм · 203 dpi")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Начать" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "В админке не настроен шаблон этикетки короба. Настройте его и повторите.",
        ),
      ).toBeDefined(),
    );
    await i18n.changeLanguage("en");
  });
});
