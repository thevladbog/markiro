import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("NewShift", () => {
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
