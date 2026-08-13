import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import { NewShift } from "../src/pages/NewShift.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());

const client = createStationClient({
  machineId: "m1",
  apiKey: "k",
  serverUrl: "http://localhost:3000",
});

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

describe("NewShift", () => {
  it("returns from the initial GTIN screen to shift selection", () => {
    const onBack = vi.fn();
    render(<NewShift client={client} onStarted={vi.fn()} onBack={onBack} />);

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
            items: [
              {
                id: "p1",
                gtin14: "04600000000015",
                name: "Cola",
                status: "active",
                boxCapacity: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const onBack = vi.fn();
    render(<NewShift client={client} onStarted={vi.fn()} onBack={onBack} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    const form = screen.getByLabelText("Type or scan a GTIN").closest("form");
    expect(form).not.toBeNull();
    if (!form) throw new Error("new shift GTIN form is missing");
    fireEvent.submit(form);
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
            items: [
              {
                id: "p1",
                gtin14: "04600000000015",
                name: "Cola",
                status: "active",
                boxCapacity: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const onBack = vi.fn();
    render(<NewShift client={client} onStarted={vi.fn()} onBack={onBack} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    const form = screen.getByLabelText("Type or scan a GTIN").closest("form");
    expect(form).not.toBeNull();
    if (!form) throw new Error("new shift GTIN form is missing");
    fireEvent.submit(form);

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

  it("keeps Back disabled while shift start is pending", async () => {
    const createShift = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "p1",
                gtin14: "04600000000015",
                name: "Cola",
                status: "active",
                boxCapacity: null,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => createShift.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );
    const onBack = vi.fn();
    const onStarted = vi.fn();
    render(<NewShift client={client} onStarted={onStarted} onBack={onBack} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    const form = screen.getByLabelText("Type or scan a GTIN").closest("form");
    expect(form).not.toBeNull();
    if (!form) throw new Error("new shift GTIN form is missing");
    fireEvent.submit(form);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    const pendingBack = screen.getByRole("button", { name: "Back" });
    await waitFor(() => expectButtonDisabled(pendingBack, true));
    fireEvent.click(pendingBack);
    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      createShift.resolve(
        new Response(JSON.stringify({ id: "s9", status: "planned", mode: "validation" }), {
          status: 201,
        }),
      );
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    await waitFor(() => expectButtonDisabled(pendingBack, false));
    fireEvent.click(pendingBack);
    expect(onBack).toHaveBeenCalledOnce();
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

    render(<NewShift client={client} onStarted={vi.fn()} onBack={() => {}} />);
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
    render(<NewShift client={client} onStarted={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), { target: { value: "123" } });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);

    await waitFor(() => expect(screen.getByText("Invalid GTIN")).toBeDefined());
    const messageSlot = screen.getByTestId("new-shift-message-slot");
    expect(messageSlot.textContent).toContain("Invalid GTIN");
  });

  it("resolves a known GTIN, creates + opens a validation shift", async () => {
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
    render(<NewShift client={client} onStarted={onStarted} onBack={() => {}} />);
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
  });

  it("shows the blocking not-in-catalog screen for an unknown GTIN", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "unknown" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    render(<NewShift client={client} onStarted={vi.fn()} onBack={() => {}} />);
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
    render(<NewShift client={client} onStarted={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), { target: { value: "123" } });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
    await waitFor(() => expect(screen.getByText("Invalid GTIN")).toBeDefined());
  });

  it("surfaces a server error on failed shift creation, disables Start while busy, and does not call onStarted", async () => {
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
    render(<NewShift client={client} onStarted={onStarted} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000015" },
    });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());

    const startButton = screen.getByRole("button", { name: "Start" });
    fireEvent.click(startButton);
    await waitFor(() => expect((startButton as HTMLButtonElement).disabled).toBe(true));

    resolveCreate(
      new Response(JSON.stringify({ message: "Product is not active" }), { status: 422 }),
    );

    await waitFor(() => expect(screen.getByText("Product is not active")).toBeDefined());
    expect(onStarted).not.toHaveBeenCalled();
  });
});
