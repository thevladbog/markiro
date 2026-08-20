import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as CounterpartiesApiModule from "../src/pages/counterparties/api.js";
import { CounterpartiesPage } from "../src/pages/counterparties/index.js";
import { CounterpartyPanelRoute } from "../src/pages/counterparties/CounterpartyPanelRoute.js";

const { writeHookMountSpy } = vi.hoisted(() => ({ writeHookMountSpy: vi.fn() }));

vi.mock("../src/pages/counterparties/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CounterpartiesApiModule>();
  return {
    ...actual,
    useCreateCounterparty: () => {
      writeHookMountSpy("create");
      return actual.useCreateCounterparty();
    },
    useUpdateCounterparty: () => {
      writeHookMountSpy("update");
      return actual.useUpdateCounterparty();
    },
    useDeleteCounterparty: () => {
      writeHookMountSpy("delete");
      return actual.useDeleteCounterparty();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  writeHookMountSpy.mockClear();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const OPERATIONS_WRITE_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

function renderPage(access: AccessDocument = OPERATIONS_WRITE_ACCESS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <RouterProvider
          router={createMemoryRouter(
            createRoutesFromElements(
              <Route path="/counterparties" element={<CounterpartiesPage />}>
                <Route path="new" element={<CounterpartyPanelRoute mode="create" />} />
                <Route
                  path=":counterpartyId/edit"
                  element={<CounterpartyPanelRoute mode="edit" />}
                />
              </Route>,
            ),
            { initialEntries: ["/counterparties"] },
          )}
        />
      </AccessProvider>
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

const COUNTER = { extensionDigit: 0, nextSerial: 45_000, minSerial: 40_000, blockedBy: null };
const COUNTER_BLOCKED = {
  ...COUNTER,
  blockedBy: { kind: "active_shift", shiftId: "s-1", shiftNumber: "AUG26-003" },
};

describe("CounterpartiesPage", () => {
  it("keeps counterparty rows readable while hiding mutations without operations.write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [ACME] })),
    );

    renderPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(ACME.name)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Добавить контрагента" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

  it("renders counterparties from the mocked GET response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [ACME] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByText("Acme Ltd")).toBeDefined();
    expect(screen.getByText("6291041500213")).toBeDefined();
    expect(screen.getByText("7701234567")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined(); // gs1Prefixes.length
    expect(screen.getByTestId("counterparties-page").classList).toContain("mk-admin-page");
    expect(screen.getByText("1 контрагент").getAttribute("aria-live")).toBe("polite");
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

    // Panel closes and the refetched list shows the newly created row.
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

  it("normalizes a historical box counter zero and blocks saving zero", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/counterparties/1/sscc") {
        return jsonResponse(200, { extensionDigit: 0, nextSerial: 0 });
      }
      return jsonResponse(200, { items: [ACME] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Acme Ltd");
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));

    const input = (await screen.findByLabelText("Начальный серийный номер")) as HTMLInputElement;
    expect(input.value).toBe("1");
    fireEvent.change(input, { target: { value: "0" } });
    const section = input.closest(".mk-counterparty-panel-section");
    if (!section) throw new Error("SSCC section not found");
    fireEvent.click(within(section as HTMLElement).getByRole("button", { name: "Сохранить SSCC" }));

    expect(await screen.findByText("Введите целое число от 1 до 9 999 999")).toBeDefined();
    expect(
      fetchMock.mock.calls.some(
        ([url, request]) =>
          url === "/api/counterparties/1/sscc" &&
          (request as RequestInit | undefined)?.method === "PUT",
      ),
    ).toBe(false);
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
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить контрагента?" });
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
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить контрагента?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    expect(await within(dialog).findByText(conflictMessage)).toBeDefined();
    expect(screen.getByRole("alertdialog", { name: "Удалить контрагента?" })).toBeDefined();
  });

  it("locks the counterparty sscc counter while a shift is active and names the shift", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/counterparties/1/sscc") {
        return jsonResponse(200, COUNTER_BLOCKED);
      }
      return jsonResponse(200, { items: [ACME] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Acme Ltd");
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));

    const input = (await screen.findByLabelText("Начальный серийный номер")) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveProperty("disabled", true));
    expect(screen.getByText(/AUG26-003/)).toBeDefined();
    const section = input.closest(".mk-counterparty-panel-section");
    if (!section) throw new Error("SSCC section not found");
    expect(
      within(section as HTMLElement).getByRole("button", { name: "Сохранить SSCC" }),
    ).toHaveProperty("disabled", true);
  });

  it("shows the floor the server reported for the counterparty counter, not a hardcoded one", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/counterparties/1/sscc") {
        return jsonResponse(200, COUNTER);
      }
      return jsonResponse(200, { items: [ACME] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Acme Ltd");
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));

    const input = (await screen.findByLabelText("Начальный серийный номер")) as HTMLInputElement;
    const section = input.closest(".mk-counterparty-panel-section");
    if (!section) throw new Error("SSCC section not found");
    await waitFor(() => expect(within(section as HTMLElement).getByText(/40\s?000/)).toBeDefined());
    expect(
      within(section as HTMLElement).getByRole("button", { name: "Сохранить SSCC" }),
    ).toHaveProperty("disabled", false);
  });
});
