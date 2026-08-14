import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
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
const resolvedProduct = {
  id: "p1",
  gtin14: "04600000000015",
  name: "Cola",
  status: "active",
  boxCapacity: null,
};
const silentSource: ScanSource = { start: () => () => {} };

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
            items: [resolvedProduct],
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
    render(
      <NewShift client={client} source={silentSource} onStarted={onStarted} onBack={onBack} />,
    );
    submitGtin();
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

  it("resolves a known GTIN, creates + opens a validation shift", async () => {
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

    const now = new Date();
    const expectedLocalDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const createRequest = fetchSpy.mock.calls[2];
    expect(createRequest?.[0]).toBe("http://localhost:3000/shifts");
    expect(JSON.parse(createRequest?.[1]?.body as string)).toEqual({
      productId: "p1",
      mode: "validation",
      plannedDate: expectedLocalDate,
    });
  });

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

  it("keeps aggregation on the found product, explains missing box labels in English, and retries after configuration", async () => {
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
            message: "Aggregation shifts require a box label template",
            code: "BOX_LABEL_TEMPLATE_REQUIRED",
          }),
          { status: 422 },
        ),
      )
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
    const startButton = screen.getByRole("button", { name: "Start" });
    fireEvent.click(startButton);

    await waitFor(() =>
      expect(
        screen.getByText(
          "A box label template is not configured in the admin panel. Configure it and try again.",
        ),
      ).toBeDefined(),
    );
    expect(screen.getByTestId("new-shift-found")).toBeDefined();
    expect(onStarted).not.toHaveBeenCalled();
    expectButtonDisabled(startButton, false);
    expect(fetchMock.mock.calls).toHaveLength(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3000/shifts");
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ productId: "p1", mode: "aggregation", plannedDate: "2026-08-14" }),
    );
    expect(screen.queryByRole("combobox")).toBeNull();

    fireEvent.click(startButton);
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith({ id: "s9", status: "active", mode: "aggregation" }),
    );
    expect(fetchMock.mock.calls[4]?.[0]).toBe("http://localhost:3000/shifts/s9/open");
  });

  it("explains missing box labels in Russian", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [resolvedProduct] }), { status: 200 }),
      )
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

    fireEvent.click(screen.getByRole("button", { name: "Агрегация" }));
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
