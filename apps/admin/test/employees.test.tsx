import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as EmployeesApiModule from "../src/pages/employees/api.js";
import { EmployeeProfileForm } from "../src/pages/employees/EmployeeProfileForm.js";
import { EmployeesPage } from "../src/pages/employees/index.js";
import { jsonResponse } from "./helpers/http.js";

const { writeHookMountSpy } = vi.hoisted(() => ({ writeHookMountSpy: vi.fn() }));

vi.mock("../src/pages/employees/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EmployeesApiModule>();
  return {
    ...actual,
    useCreateEmployee: () => {
      writeHookMountSpy("create");
      return actual.useCreateEmployee();
    },
    useUpdateEmployee: () => {
      writeHookMountSpy("update");
      return actual.useUpdateEmployee();
    },
    useArchiveEmployee: () => {
      writeHookMountSpy("archive");
      return actual.useArchiveEmployee();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  writeHookMountSpy.mockClear();
});

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
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AccessProvider value={access}>
          <MemoryRouter initialEntries={["/employees"]}>
            <EmployeesPage />
          </MemoryRouter>
        </AccessProvider>
      </QueryClientProvider>,
    ),
  };
}

async function chooseOption(label: string, option: string) {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pageX: 0,
    pageY: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("option", { name: option }));
  expect(trigger.textContent).toContain(option);
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

const INITIAL_EMPLOYEE_PROFILE_VALUES = { fullName: "Jane Doe", role: "Кассир" };

function DirtyProfileReseedHarness() {
  const [initialValues, setInitialValues] = useState(INITIAL_EMPLOYEE_PROFILE_VALUES);
  return (
    <div
      onChange={() =>
        setInitialValues({
          ...INITIAL_EMPLOYEE_PROFILE_VALUES,
          fullName: "Jane Refetched",
        })
      }
    >
      <EmployeeProfileForm
        mode="edit"
        initialValues={initialValues}
        submitting={false}
        submissionError={null}
        onSubmit={() => undefined}
        onDirtyChange={() => undefined}
      />
    </div>
  );
}

describe("EmployeeProfileForm", () => {
  it("does not reseed over an employee edit when initial values change in the same commit", () => {
    render(<DirtyProfileReseedHarness />);
    const name = screen.getByLabelText("ФИО") as HTMLInputElement;
    // The input change and incoming initial values are committed together.
    fireEvent.change(name, { target: { value: "Jane Draft" } });

    expect(name.value).toBe("Jane Draft");
  });
});

describe("EmployeesPage", () => {
  it("uses the shared page/filter layout and requests the selected status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [JANE] }));
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    expect(await screen.findByTestId("employees-page")).toBeDefined();
    expect(screen.getByRole("group", { name: "Фильтры сотрудников" })).toBeDefined();
    await chooseOption("Статус", "Активные");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/employees?status=active", expect.any(Object)),
    );
    expect(screen.getByText("1 сотрудник").getAttribute("aria-live")).toBe("polite");
  });

  it("uses the unfiltered request by default and resets a selected status to all", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [JANE] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(JANE.fullName);
    expect(fetchMock).toHaveBeenCalledWith("/api/employees", expect.any(Object));

    await chooseOption("Статус", "В архиве");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/employees?status=archived", expect.any(Object)),
    );
    await user.click(screen.getByRole("button", { name: "Сбросить" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith("/api/employees", expect.any(Object)),
    );
  });

  it("offers reset instead of a duplicate create action for an empty filtered list", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      jsonResponse(200, { items: url.includes("status=archived") ? [] : [JANE] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await screen.findByText(JANE.fullName);
    await chooseOption("Статус", "В архиве");

    expect(await screen.findByText("Нет сотрудников с выбранным статусом")).toBeDefined();
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Добавить сотрудника" })).toHaveLength(1);
  });

  it("keeps archive confirmation open with the server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "DELETE"
          ? jsonResponse(409, { message: "Employee has an active shift" })
          : jsonResponse(200, { items: [JANE] }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "В архив" }));
    const dialog = screen.getByRole("alertdialog", { name: "Отправить сотрудника в архив?" });
    await user.click(within(dialog).getByRole("button", { name: "В архив" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Employee has an active shift",
    );
    expect(
      screen.getByRole("alertdialog", { name: "Отправить сотрудника в архив?" }),
    ).toBeDefined();
  });

  it("keeps employee rows readable while hiding all mutations without operations.write", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/employees")) {
        return jsonResponse(200, { items: [JANE] });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(JANE.fullName)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Добавить сотрудника" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/operators"))).toBe(
      false,
    );
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

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

  it("gives read-only users empty guidance that does not suggest an unavailable action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    renderPage(OPERATIONS_READ_ONLY);

    expect(
      await screen.findByText(
        "Обратитесь к администратору с правом редактирования, чтобы добавить сотрудников.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Добавьте первого сотрудника/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить сотрудника" })).toBeNull();
  });

  it("shows an accessible table-shaped skeleton (not EmptyState) while loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    const loading = await screen.findByRole("status");
    expect(loading.classList).toContain("mk-employees-table-skeleton");
    expect(loading.querySelectorAll("thead th")).toHaveLength(5);
    expect(loading.querySelectorAll("tbody tr")).toHaveLength(3);
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

  it("calls DELETE after confirming archive in the archive confirmation", async () => {
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
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Отправить сотрудника в архив?")).toBeDefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/employees/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
