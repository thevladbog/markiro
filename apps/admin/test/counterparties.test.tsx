import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CounterpartiesPage } from "../src/pages/counterparties/index.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CounterpartiesPage />
    </QueryClientProvider>,
  );
}

const ACME = {
  id: "1",
  name: "Acme Ltd",
  gln: "6291041500213",
  inn: "7701234567",
  gs1Prefixes: ["4600000", "4600001"],
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("CounterpartiesPage", () => {
  it("renders counterparties from the mocked GET response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [ACME] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByText("Acme Ltd")).toBeDefined();
    expect(screen.getByText("6291041500213")).toBeDefined();
    expect(screen.getByText("7701234567")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined(); // gs1Prefixes.length
    expect(fetchMock).toHaveBeenCalledWith("/api/counterparties", expect.any(Object));
  });

  it("shows EmptyState when the list is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    renderPage();

    expect(await screen.findByText("Контрагенты не добавлены")).toBeDefined();
    expect(
      screen.getByText("Добавьте первого контрагента — держателя ГТИН или толлингового партнёра."),
    ).toBeDefined();
  });

  it("shows a spinner (not EmptyState) while the list request is still pending", async () => {
    // A fetch that never resolves keeps the query in isPending forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Контрагенты не добавлены")).toBeNull();
  });

  it("shows an error alert (not EmptyState) when the list request fails, e.g. an expired session (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("Контрагенты не добавлены")).toBeNull();
  });

  it("opens the create modal from the page header action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    renderPage();
    await screen.findByText("Контрагенты не добавлены");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить контрагента" })[0]!);

    expect(await screen.findByText("Новый контрагент")).toBeDefined();
  });

  it("shows a validation error for an invalid GLN check digit before submitting (no POST)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Контрагенты не добавлены");
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить контрагента" })[0]!);
    await screen.findByText("Новый контрагент");

    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Bad Co" } });
    // Correct length/format (13 digits) but wrong check digit (valid vector ends in 3).
    fireEvent.change(screen.getByLabelText("GLN"), { target: { value: "6291041500214" } });

    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    expect(await screen.findByText("Неверная контрольная цифра GLN")).toBeDefined();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
  });

  it("shows a validation error when the name is empty (no POST)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Контрагенты не добавлены");
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить контрагента" })[0]!);
    await screen.findByText("Новый контрагент");

    fireEvent.change(screen.getByLabelText("GLN"), { target: { value: "6291041500213" } });

    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    expect(await screen.findByText("Укажите название")).toBeDefined();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
  });

  it("submits a normalized payload on valid create and refetches the list", async () => {
    const created = {
      id: "2",
      name: "Good Co",
      gln: "6291041500213",
      inn: null,
      gs1Prefixes: ["4600000", "4600001"],
      notes: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    };
    let didCreate = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        didCreate = true;
        return jsonResponse(201, created);
      }
      return jsonResponse(200, { items: didCreate ? [created] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Контрагенты не добавлены");
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить контрагента" })[0]!);
    await screen.findByText("Новый контрагент");

    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Good Co" } });
    fireEvent.change(screen.getByLabelText("GLN"), { target: { value: "6291041500213" } });
    fireEvent.change(screen.getByLabelText("Префиксы GS1"), {
      target: { value: " 4600000 , 4600001 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/counterparties",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Good Co",
            gln: "6291041500213",
            inn: null,
            gs1Prefixes: ["4600000", "4600001"],
            notes: null,
          }),
        }),
      );
    });

    // Modal closes and the refetched list shows the newly created row.
    await waitFor(() => expect(screen.queryByText("Новый контрагент")).toBeNull());
    expect(await screen.findByText("Good Co")).toBeDefined();
  });

  it("edits an existing counterparty via the row action (prefilled form, PATCH on submit)", async () => {
    const updated = { ...ACME, name: "Acme Updated" };
    let didPatch = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        didPatch = true;
        return jsonResponse(200, updated);
      }
      return jsonResponse(200, { items: [didPatch ? updated : ACME] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Acme Ltd");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить контрагента");

    const nameInput = screen.getByLabelText("Название") as HTMLInputElement;
    expect(nameInput.value).toBe("Acme Ltd");
    const glnInput = screen.getByLabelText("GLN") as HTMLInputElement;
    expect(glnInput.value).toBe("6291041500213");

    fireEvent.change(nameInput, { target: { value: "Acme Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/counterparties/1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    expect(await screen.findByText("Acme Updated")).toBeDefined();
  });

  it("calls DELETE after confirming in the delete modal", async () => {
    let didDelete = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        didDelete = true;
        return jsonResponse(204, undefined);
      }
      return jsonResponse(200, { items: didDelete ? [] : [ACME] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Acme Ltd");

    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Удалить контрагента?")).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/counterparties/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("shows a toast with the server message when delete returns 409", async () => {
    const conflictMessage = "Counterparty is referenced by products or shifts";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return jsonResponse(409, { message: conflictMessage });
      }
      return jsonResponse(200, { items: [ACME] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Acme Ltd");

    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    expect(await screen.findByText(conflictMessage)).toBeDefined();
  });
});
