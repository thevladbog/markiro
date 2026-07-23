import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmployeesPage } from "../src/pages/employees/index.js";

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
      <EmployeesPage />
    </QueryClientProvider>,
  );
}

const JANE = {
  id: "1",
  fullName: "Jane Doe",
  role: "Кассир",
  status: "active",
  badges: [
    {
      id: "b1",
      badgeCode: "AAA111",
      label: "Основной бейдж",
      issuedAt: "2026-01-01T00:00:00.000Z",
      revokedAt: null,
    },
    {
      id: "b2",
      badgeCode: "BBB222",
      label: null,
      issuedAt: "2025-12-01T00:00:00.000Z",
      revokedAt: "2025-12-15T00:00:00.000Z",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("EmployeesPage", () => {
  it("renders employees from the mocked GET response, incl. role, status, and active-badge count", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [JANE] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByText("Jane Doe")).toBeDefined();
    expect(screen.getByText("Кассир")).toBeDefined();
    expect(screen.getByText("Активен")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined(); // only 1 active badge (b2 is revoked)
    expect(fetchMock).toHaveBeenCalledWith("/api/employees", expect.any(Object));
  });

  it("shows '—' for a null role", async () => {
    const noRole = { ...JANE, id: "2", fullName: "Ivan Ivanov", role: null, badges: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [noRole] })),
    );

    renderPage();

    expect(await screen.findByText("Ivan Ivanov")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
  });

  it("shows EmptyState when the list is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    renderPage();

    expect(await screen.findByText("Сотрудники не добавлены")).toBeDefined();
  });

  it("shows a spinner (not EmptyState) while the list request is still pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Сотрудники не добавлены")).toBeNull();
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
    expect(screen.queryByText("Сотрудники не добавлены")).toBeNull();
  });

  it("opens the create modal from the page header action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    renderPage();
    await screen.findByText("Сотрудники не добавлены");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить сотрудника" })[0]!);

    expect(await screen.findByText("Новый сотрудник")).toBeDefined();
  });

  it("shows a validation error when the name is empty (no POST)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Сотрудники не добавлены");
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить сотрудника" })[0]!);
    await screen.findByText("Новый сотрудник");

    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    expect(await screen.findByText("Укажите ФИО")).toBeDefined();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
  });

  it("submits fullName on valid create and refetches the list", async () => {
    const created = {
      id: "3",
      fullName: "Pyotr Petrov",
      role: null,
      status: "active",
      badges: [],
      createdAt: "2026-01-02T00:00:00.000Z",
    };
    let didCreate = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && !url.includes("/badges")) {
        didCreate = true;
        return jsonResponse(201, created);
      }
      return jsonResponse(200, { items: didCreate ? [created] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Сотрудники не добавлены");
    fireEvent.click(screen.getAllByRole("button", { name: "Добавить сотрудника" })[0]!);
    await screen.findByText("Новый сотрудник");

    fireEvent.change(screen.getByLabelText("ФИО"), { target: { value: "Pyotr Petrov" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/employees",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ fullName: "Pyotr Petrov", role: null }),
        }),
      );
    });

    await waitFor(() => expect(screen.queryByText("Новый сотрудник")).toBeNull());
    expect(await screen.findByText("Pyotr Petrov")).toBeDefined();
  });

  it("edits an existing employee via the row action (prefilled form, PATCH on submit)", async () => {
    const updated = { ...JANE, fullName: "Jane Updated" };
    let didPatch = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        didPatch = true;
        return jsonResponse(200, updated);
      }
      return jsonResponse(200, { items: [didPatch ? updated : JANE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить сотрудника");

    const nameInput = screen.getByLabelText("ФИО") as HTMLInputElement;
    expect(nameInput.value).toBe("Jane Doe");

    fireEvent.change(nameInput, { target: { value: "Jane Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/employees/1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    expect(await screen.findByText("Jane Updated")).toBeDefined();
  });

  it("calls DELETE after confirming archive in the archive-confirm modal", async () => {
    let didArchive = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && !url.includes("/badges")) {
        didArchive = true;
        return jsonResponse(204, undefined);
      }
      return jsonResponse(200, { items: didArchive ? [] : [JANE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: "В архив" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Отправить сотрудника в архив?")).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/employees/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("opens an employee in edit mode and issues a badge (POST /api/employees/:id/badges with badgeCode)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/badges")) {
        return jsonResponse(201, JANE);
      }
      return jsonResponse(200, { items: [JANE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить сотрудника");

    fireEvent.change(screen.getByLabelText("Код бейджа"), { target: { value: "CCC333" } });
    fireEvent.click(screen.getByRole("button", { name: "Выпустить бейдж" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/employees/1/badges",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ badgeCode: "CCC333", label: null }),
        }),
      );
    });
  });

  it("shows a toast with the server message when issuing a duplicate badge returns 409", async () => {
    const conflictMessage = "Badge code already active";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/badges")) {
        return jsonResponse(409, { message: conflictMessage });
      }
      return jsonResponse(200, { items: [JANE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить сотрудника");

    fireEvent.change(screen.getByLabelText("Код бейджа"), { target: { value: "AAA111" } });
    fireEvent.click(screen.getByRole("button", { name: "Выпустить бейдж" }));

    expect(await screen.findByText(conflictMessage)).toBeDefined();
  });

  it("revokes an active badge (DELETE /api/employees/:id/badges/:badgeId)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && url.includes("/badges/")) {
        return jsonResponse(204, undefined);
      }
      return jsonResponse(200, { items: [JANE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить сотрудника");

    fireEvent.click(screen.getByRole("button", { name: "Отозвать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/employees/1/badges/b1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
