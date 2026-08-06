import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider, RequireCapability } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import type * as EmployeesApiModule from "../src/pages/employees/api.js";
import { EMPLOYEES_QUERY_KEY } from "../src/pages/employees/api.js";
import {
  EmployeeCreatePanelRoute,
  EmployeeEditPanelRoute,
} from "../src/pages/employees/EmployeePanelRoute.js";
import { EmployeesPage } from "../src/pages/employees/index.js";
import type * as StationAccessApiModule from "../src/pages/employees/station-access-api.js";

const { createHookMountSpy, operatorsHookMountSpy, updateHookMountSpy } = vi.hoisted(() => ({
  createHookMountSpy: vi.fn(),
  operatorsHookMountSpy: vi.fn(),
  updateHookMountSpy: vi.fn(),
}));

vi.mock("../src/pages/employees/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EmployeesApiModule>();
  return {
    ...actual,
    useCreateEmployee: () => {
      createHookMountSpy();
      return actual.useCreateEmployee();
    },
    useUpdateEmployee: () => {
      updateHookMountSpy();
      return actual.useUpdateEmployee();
    },
  };
});

vi.mock("../src/pages/employees/station-access-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof StationAccessApiModule>();
  return {
    ...actual,
    useOperators: () => {
      operatorsHookMountSpy();
      return actual.useOperators();
    },
  };
});

const WRITE_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const READ_ONLY_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const JANE = {
  id: "1",
  fullName: "Jane Doe",
  role: "Кассир",
  status: "active",
  badges: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ACTIVE_OPERATOR = {
  employeeId: "1",
  fullName: "Jane Doe",
  role: "Кассир",
  login: "123456",
  active: true,
  hasBadge: false,
};

const JOHN: typeof JANE = {
  ...JANE,
  id: "2",
  fullName: "John Roe",
  role: "Кладовщик",
};

const JOHN_OPERATOR: typeof ACTIVE_OPERATOR = {
  ...ACTIVE_OPERATOR,
  employeeId: "2",
  fullName: "John Roe",
  role: "Кладовщик",
  login: "654321",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubEmployeeAndOperators({
  employees = [JANE],
  operators = [ACTIVE_OPERATOR],
}: {
  employees?: (typeof JANE)[];
  operators?: (typeof ACTIVE_OPERATOR)[];
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "/api/employees") return jsonResponse(200, { items: employees });
      if (String(url) === "/api/operators") return jsonResponse(200, { items: operators });
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
}

function renderPanel(
  initialEntries: string[] = ["/employees"],
  access: AccessDocument = WRITE_ACCESS,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route
        path="/employees"
        element={
          <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_READ}>
            <EmployeesPage />
          </RequireCapability>
        }
      >
        <Route
          path="new"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_WRITE}>
              <EmployeeCreatePanelRoute />
            </RequireCapability>
          }
        />
        <Route
          path=":employeeId/edit"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_WRITE}>
              <EmployeeEditPanelRoute />
            </RequireCapability>
          }
        />
      </Route>,
    ),
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { queryClient, router, user };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  createHookMountSpy.mockClear();
  operatorsHookMountSpy.mockClear();
  updateHookMountSpy.mockClear();
  await i18n.changeLanguage("ru");
});

it("opens creation over the mounted list, submits the exact payload, and returns focus", async () => {
  const created = {
    ...JANE,
    id: "2",
    fullName: "Анна Смирнова",
    role: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  };
  let didCreate = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/employees" && init?.method === "POST") {
      didCreate = true;
      return jsonResponse(201, created);
    }
    return jsonResponse(200, { items: didCreate ? [JANE, created] : [JANE] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { router, user } = renderPanel();

  const addAction = await screen.findByRole("button", { name: "Добавить сотрудника" });
  await user.click(addAction);

  expect(router.state.location.pathname).toBe("/employees/new");
  expect(screen.getByText("Jane Doe")).toBeDefined();
  const panel = screen.getByRole("dialog", { name: "Новый сотрудник" });
  await user.type(within(panel).getByLabelText("ФИО"), "Анна Смирнова");
  await user.click(within(panel).getByRole("button", { name: "Создать" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/employees",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ fullName: "Анна Смирнова", role: null }),
      }),
    ),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
  expect(await screen.findByText("Сотрудник добавлен")).toBeDefined();
  expect(document.activeElement).toBe(addAction);
  expect(await screen.findByText("Анна Смирнова")).toBeDefined();
});

it("falls back to the employees list when a directly entered panel closes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router, user } = renderPanel(["/employees/new"]);

  await screen.findByLabelText("ФИО");
  const panel = await screen.findByRole("dialog", { name: "Новый сотрудник" });
  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("shows the panel load error and retries the employees request", async () => {
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "/api/employees") {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, { message: "Unavailable" })
          : jsonResponse(200, { items: [] });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  renderPanel(["/employees/new"]);

  const panel = await screen.findByRole("dialog", { name: "Новый сотрудник" });
  expect((await within(panel).findByRole("alert")).textContent).toContain(
    "Не удалось загрузить данные сотрудника.",
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Повторить" }));

  expect(await screen.findByLabelText("ФИО")).toBeDefined();
  expect(attempts).toBe(2);
});

it("blocks Back after the employee form becomes dirty until discard is confirmed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router, user } = renderPanel(["/employees", "/employees/new"]);

  await user.type(await screen.findByLabelText("ФИО"), "Анна");
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/employees/new");
  const confirmation = await screen.findByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Не сохранять" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("localizes the dirty dismissal controls in English", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { user } = renderPanel(["/employees/new"]);

  await user.type(await screen.findByLabelText("Full name"), "Anna");
  await user.click(screen.getByRole("button", { name: "Close" }));

  expect(screen.getByRole("alertdialog", { name: "Discard changes?" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Continue editing" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Discard" })).toBeDefined();
});

it("blocks every dismissal and duplicate submission while creation is pending", async () => {
  let resolveCreate: ((response: Response) => void) | undefined;
  const createResponse = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/employees" && init?.method === "POST") return createResponse;
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { router, user } = renderPanel(["/employees", "/employees/new"]);

  await user.type(await screen.findByLabelText("ФИО"), "Анна");
  const panel = screen.getByRole("dialog", { name: "Новый сотрудник" });
  const submit = within(panel).getByRole("button", { name: "Создать" });
  await user.click(submit);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/employees" && init?.method === "POST",
      ),
    ).toHaveLength(1),
  );

  expect(
    (within(panel).getByRole("button", { name: "Закрыть" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (within(panel).getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await user.click(submit);
  await user.keyboard("{Escape}");
  fireEvent.mouseDown(document.querySelector<HTMLElement>(".mk-side-panel__scrim")!);
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/employees/new");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === "/api/employees" && init?.method === "POST",
    ),
  ).toHaveLength(1);

  resolveCreate?.(
    jsonResponse(201, {
      ...JANE,
      id: "2",
      fullName: "Анна",
      role: null,
    }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("keeps validation client-side when the full name is empty", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse(200, { items: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { user } = renderPanel(["/employees/new"]);

  await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Новый сотрудник" });
  await user.click(within(panel).getByRole("button", { name: "Создать" }));

  expect(await within(panel).findByText("Укажите ФИО")).toBeDefined();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("keeps the panel, profile values, and persistent API error after a failed create", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse(409, { message: "Employee already exists" })
        : jsonResponse(200, { items: [] }),
    ),
  );
  const { router, user } = renderPanel(["/employees/new"]);

  await user.type(await screen.findByLabelText("ФИО"), "Анна Смирнова");
  await user.click(screen.getByRole("button", { name: "Создать" }));

  const panel = screen.getByRole("dialog", { name: "Новый сотрудник" });
  expect(await within(panel).findByText("Employee already exists")).toBeDefined();
  expect((within(panel).getByLabelText("ФИО") as HTMLInputElement).value).toBe("Анна Смирнова");
  expect(router.state.location.pathname).toBe("/employees/new");
});

it("denies a direct read-only URL before the privileged create hook mounts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  renderPanel(["/employees/new"], READ_ONLY_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(createHookMountSpy).not.toHaveBeenCalled();
});

it("opens editing over the mounted list, identifies the employee, and returns focus", async () => {
  stubEmployeeAndOperators();
  const { router, user } = renderPanel();

  const editAction = await screen.findByRole("button", { name: "Изменить" });
  await user.click(editAction);

  expect(router.state.location.pathname).toBe("/employees/1/edit");
  expect(screen.getByText("Jane Doe")).toBeDefined();
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  expect(panel.textContent).toContain("Jane Doe");
  expect(panel.textContent).toContain("Кассир");

  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
  expect(document.activeElement).toBe(editAction);
});

it("falls back to the employees list when a directly entered edit panel closes", async () => {
  stubEmployeeAndOperators();
  const { router, user } = renderPanel(["/employees/1/edit"]);

  await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("shows a translated not-found state for an unknown employee", async () => {
  stubEmployeeAndOperators({ employees: [], operators: [] });
  const { router, user } = renderPanel(["/employees/missing/edit"]);

  expect((await screen.findByRole("alert")).textContent).toContain("Сотрудник не найден.");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  expect(operatorsHookMountSpy).not.toHaveBeenCalled();

  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("does not reuse a retained employee when the edit route changes to an unknown id", async () => {
  stubEmployeeAndOperators();
  const { router } = renderPanel(["/employees/1/edit"]);

  expect(await screen.findByDisplayValue("Jane Doe")).toBeDefined();

  await act(async () => {
    await router.navigate("/employees/missing/edit");
  });

  expect((await screen.findByRole("alert")).textContent).toContain("Сотрудник не найден.");
  expect(screen.queryByDisplayValue("Jane Doe")).toBeNull();
});

it("clears every resource draft after discarding navigation to another employee", async () => {
  stubEmployeeAndOperators({
    employees: [JANE, JOHN],
    operators: [ACTIVE_OPERATOR, JOHN_OPERATOR],
  });
  const { router, user } = renderPanel(["/employees/1/edit"]);

  const fullName = await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  await user.type(fullName, " draft");
  await user.type(within(panel).getByLabelText("Код бейджа"), "BADGE-DRAFT");
  await user.type(await within(panel).findByLabelText("ПИН-код"), "4321");

  await router.navigate("/employees/2/edit");
  const confirmation = await screen.findByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Не сохранять" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/employees/2/edit"));
  const nextPanel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  expect((within(nextPanel).getByLabelText("ФИО") as HTMLInputElement).value).toBe("John Roe");
  expect((within(nextPanel).getByLabelText("Код бейджа") as HTMLInputElement).value).toBe("");
  expect((within(nextPanel).getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("");
});

it("shows the edit-panel load error and retries before mounting employee resources", async () => {
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "/api/employees") {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, { message: "Unavailable" })
          : jsonResponse(200, { items: [JANE] });
      }
      if (String(url) === "/api/operators") {
        return jsonResponse(200, { items: [ACTIVE_OPERATOR] });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  renderPanel(["/employees/1/edit"]);

  await screen.findByText("Не удалось загрузить данные сотрудника.");
  let panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  expect(within(panel).getByRole("alert").textContent).toContain(
    "Не удалось загрузить данные сотрудника.",
  );
  expect(operatorsHookMountSpy).not.toHaveBeenCalled();

  fireEvent.click(within(panel).getByRole("button", { name: "Повторить" }));

  expect(await screen.findByLabelText("ФИО")).toBeDefined();
  panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  expect(within(panel).getByLabelText("ФИО")).toBeDefined();
  expect(attempts).toBe(2);
  expect(operatorsHookMountSpy).toHaveBeenCalled();
});

it("keeps dirty editor resources and discard protection after a cached-list refetch fails", async () => {
  let employeeAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "/api/employees") {
        employeeAttempts += 1;
        return employeeAttempts === 1
          ? jsonResponse(200, { items: [JANE] })
          : jsonResponse(503, { message: "Refetch unavailable" });
      }
      if (String(url) === "/api/operators") {
        return jsonResponse(200, { items: [ACTIVE_OPERATOR] });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  const { queryClient, router, user } = renderPanel(["/employees/1/edit"]);

  const fullName = await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const badgeCode = within(panel).getByLabelText("Код бейджа");
  const pin = await within(panel).findByLabelText("ПИН-код");
  await user.type(fullName, " draft");
  await user.type(badgeCode, "BADGE-DRAFT");
  await user.type(pin, "4321");

  await act(async () => {
    await queryClient.refetchQueries({ queryKey: EMPLOYEES_QUERY_KEY });
  });

  expect(employeeAttempts).toBe(2);
  await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново.");
  await waitFor(() => expect(screen.getByRole("region", { name: "Профиль" })).toBeDefined());
  const retainedPanel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  expect(retainedPanel).toBe(panel);
  expect(within(retainedPanel).getByRole("region", { name: "Бейджи" })).toBeDefined();
  expect(within(retainedPanel).getByRole("region", { name: "Доступ на станцию" })).toBeDefined();
  expect((within(retainedPanel).getByLabelText("ФИО") as HTMLInputElement).value).toBe(
    "Jane Doe draft",
  );
  expect((within(retainedPanel).getByLabelText("Код бейджа") as HTMLInputElement).value).toBe(
    "BADGE-DRAFT",
  );
  expect((within(retainedPanel).getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("4321");

  await user.click(within(retainedPanel).getByRole("button", { name: "Закрыть" }));
  const confirmation = screen.getByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Продолжить редактирование" }));
  expect((within(retainedPanel).getByLabelText("ФИО") as HTMLInputElement).value).toBe(
    "Jane Doe draft",
  );

  await user.click(within(retainedPanel).getByRole("button", { name: "Закрыть" }));
  await user.click(
    within(screen.getByRole("alertdialog", { name: "Отменить изменения?" })).getByRole("button", {
      name: "Не сохранять",
    }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("keeps a dirty create editor and discard flow after an empty cached-list refetch fails", async () => {
  let employeeAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "/api/employees") {
        employeeAttempts += 1;
        return employeeAttempts === 1
          ? jsonResponse(200, { items: [] })
          : jsonResponse(503, { message: "Refetch unavailable" });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  const { queryClient, router, user } = renderPanel(["/employees", "/employees/new"]);

  const fullName = await screen.findByLabelText("ФИО");
  await user.type(fullName, "Анна Чернова");

  await act(async () => {
    await queryClient.refetchQueries({ queryKey: EMPLOYEES_QUERY_KEY });
  });

  expect(employeeAttempts).toBe(2);
  const panel = screen.getByRole("dialog", { name: "Новый сотрудник" });
  expect((within(panel).getByLabelText("ФИО") as HTMLInputElement).value).toBe("Анна Чернова");

  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));
  const confirmation = screen.getByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Продолжить редактирование" }));
  expect((within(panel).getByLabelText("ФИО") as HTMLInputElement).value).toBe("Анна Чернова");

  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));
  await user.click(
    within(screen.getByRole("alertdialog", { name: "Отменить изменения?" })).getByRole("button", {
      name: "Не сохранять",
    }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("keeps dirty Profile, Badge, and PIN drafts recoverable when a refetch omits the edited employee", async () => {
  let employeeAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "/api/employees") {
        employeeAttempts += 1;
        return jsonResponse(200, { items: employeeAttempts === 1 ? [JANE] : [] });
      }
      if (String(url) === "/api/operators") {
        return jsonResponse(200, { items: [ACTIVE_OPERATOR] });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  const { queryClient, router, user } = renderPanel(["/employees", "/employees/1/edit"]);

  const fullName = await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  await user.type(fullName, " draft");
  await user.type(within(panel).getByLabelText("Код бейджа"), "BADGE-DRAFT");
  await user.type(await within(panel).findByLabelText("ПИН-код"), "4321");

  await act(async () => {
    await queryClient.refetchQueries({ queryKey: EMPLOYEES_QUERY_KEY });
  });

  expect(employeeAttempts).toBe(2);
  expect(
    await screen.findByText(
      "Сотрудник больше не входит в текущий список. Черновики сохранятся, пока открыта эта панель.",
    ),
  ).toBeDefined();
  const retainedPanel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  expect(retainedPanel).toBe(panel);
  expect((within(retainedPanel).getByLabelText("ФИО") as HTMLInputElement).value).toBe(
    "Jane Doe draft",
  );
  expect((within(retainedPanel).getByLabelText("Код бейджа") as HTMLInputElement).value).toBe(
    "BADGE-DRAFT",
  );
  expect((within(retainedPanel).getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("4321");

  await user.click(within(retainedPanel).getByRole("button", { name: "Закрыть" }));
  const confirmation = screen.getByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Продолжить редактирование" }));
  expect((within(retainedPanel).getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("4321");

  await user.click(within(retainedPanel).getByRole("button", { name: "Закрыть" }));
  await user.click(
    within(screen.getByRole("alertdialog", { name: "Отменить изменения?" })).getByRole("button", {
      name: "Не сохранять",
    }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("keeps all employee resources mounted with named section metadata", async () => {
  stubEmployeeAndOperators();
  renderPanel(["/employees/1/edit"]);

  await screen.findByRole("region", { name: "Профиль" });
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const profile = within(panel).getByRole("region", { name: "Профиль" });
  const badges = within(panel).getByRole("region", { name: "Бейджи" });
  const stationAccess = within(panel).getByRole("region", { name: "Доступ на станцию" });
  expect(profile).toBeDefined();
  expect(badges).toBeDefined();
  expect(stationAccess).toBeDefined();
  await within(stationAccess).findByText("Табельный номер 123456");

  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  const profileNav = within(sectionNav).getByRole("button", { name: /Профиль/ });
  const badgesNav = within(sectionNav).getByRole("button", { name: /Бейджи/ });
  const stationAccessNav = within(sectionNav).getByRole("button", {
    name: /Доступ на станцию/,
  });
  expect(profileNav.getAttribute("aria-current")).toBe("location");
  expect(badgesNav.textContent).toContain("0");
  await waitFor(() => expect(stationAccessNav.textContent).toContain("Активен"));
});

it("shows one Station access error marker instead of duplicating the error status", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "/api/employees") return jsonResponse(200, { items: [JANE] });
      if (String(url) === "/api/operators") return jsonResponse(503, { message: "Unavailable" });
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  renderPanel(["/employees/1/edit"]);

  await screen.findByText("Не удалось загрузить статус доступа на станцию.");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  const stationAccessNav = within(sectionNav).getByRole("button", {
    name: /Доступ на станцию/,
  });

  expect(within(stationAccessNav).getAllByText("Ошибка")).toHaveLength(1);
});

it("normalizes section geometry to the panel body for scroll and click navigation", async () => {
  stubEmployeeAndOperators();
  const { user } = renderPanel(["/employees/1/edit"]);

  await screen.findByRole("region", { name: "Профиль" });
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const profile = within(panel).getByRole("region", { name: "Профиль" });
  const badges = within(panel).getByRole("region", { name: "Бейджи" });
  const stationAccess = within(panel).getByRole("region", { name: "Доступ на станцию" });
  const scrollRoot = panel.querySelector<HTMLElement>(".mk-side-panel__body");
  if (!scrollRoot) throw new Error("Panel scroll root not found");
  Object.defineProperty(scrollRoot, "scrollTop", { configurable: true, value: 300 });
  vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
  vi.spyOn(profile, "getBoundingClientRect").mockReturnValue({ top: -200 } as DOMRect);
  vi.spyOn(badges, "getBoundingClientRect").mockReturnValue({ top: 110 } as DOMRect);
  let stationTop = 400;
  vi.spyOn(stationAccess, "getBoundingClientRect").mockImplementation(
    () => ({ top: stationTop }) as DOMRect,
  );

  fireEvent.scroll(scrollRoot);

  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  const badgesNav = within(sectionNav).getByRole("button", { name: /Бейджи/ });
  const stationAccessNav = within(sectionNav).getByRole("button", {
    name: /Доступ на станцию/,
  });
  await waitFor(() => expect(badgesNav.getAttribute("aria-current")).toBe("location"));

  const stationHeading = within(stationAccess).getByRole("heading", {
    name: "Доступ на станцию",
  });
  const sectionScrollIntoView = vi.fn(() => {
    stationTop = 132;
  });
  Object.defineProperty(stationAccess, "scrollIntoView", {
    configurable: true,
    value: sectionScrollIntoView,
  });
  Object.defineProperty(stationHeading, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  await user.click(stationAccessNav);

  expect(sectionScrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(stationAccessNav.getAttribute("aria-current")).toBe("location");
  expect(document.activeElement).toBe(stationHeading);

  fireEvent.scroll(scrollRoot);
  await waitFor(() => expect(stationAccessNav.getAttribute("aria-current")).toBe("location"));
});

it("marks Station access active when the panel body reaches its real scroll bottom", async () => {
  stubEmployeeAndOperators();
  renderPanel(["/employees/1/edit"]);

  await screen.findByRole("region", { name: "Профиль" });
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const profile = within(panel).getByRole("region", { name: "Профиль" });
  const badges = within(panel).getByRole("region", { name: "Бейджи" });
  const stationAccess = within(panel).getByRole("region", { name: "Доступ на станцию" });
  const scrollRoot = panel.querySelector<HTMLElement>(".mk-side-panel__body");
  if (!scrollRoot) throw new Error("Panel scroll root not found");
  Object.defineProperty(scrollRoot, "scrollTop", { configurable: true, value: 300 });
  Object.defineProperty(scrollRoot, "clientHeight", { configurable: true, value: 500 });
  Object.defineProperty(scrollRoot, "scrollHeight", { configurable: true, value: 800 });
  vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
  vi.spyOn(profile, "getBoundingClientRect").mockReturnValue({ top: -200 } as DOMRect);
  vi.spyOn(badges, "getBoundingClientRect").mockReturnValue({ top: 110 } as DOMRect);
  vi.spyOn(stationAccess, "getBoundingClientRect").mockReturnValue({ top: 400 } as DOMRect);

  fireEvent.scroll(scrollRoot);

  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  const stationAccessNav = within(sectionNav).getByRole("button", {
    name: /Доступ на станцию/,
  });
  await waitFor(() => expect(stationAccessNav.getAttribute("aria-current")).toBe("location"));
});

it("marks Profile navigation when client-side validation fails", async () => {
  stubEmployeeAndOperators();
  const { user } = renderPanel(["/employees/1/edit"]);

  const fullName = await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  await user.clear(fullName);
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));

  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  expect(await within(sectionNav).findByRole("button", { name: /Профиль.*Ошибка/ })).toBeDefined();
});

it("submits only the exact normalized profile PATCH and closes after success", async () => {
  const updated = { ...JANE, fullName: "Jane Updated", role: null };
  let didPatch = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/employees/1" && init?.method === "PATCH") {
      didPatch = true;
      return jsonResponse(200, updated);
    }
    if (String(url) === "/api/employees") {
      return jsonResponse(200, { items: [didPatch ? updated : JANE] });
    }
    if (String(url) === "/api/operators") {
      return jsonResponse(200, { items: [ACTIVE_OPERATOR] });
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const { router, user } = renderPanel(["/employees", "/employees/1/edit"]);

  await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const fullName = within(panel).getByLabelText("ФИО");
  const role = within(panel).getByLabelText("Должность");
  await user.clear(fullName);
  await user.type(fullName, "  Jane Updated  ");
  await user.clear(role);
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/employees/1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ fullName: "Jane Updated", role: null }),
      }),
    ),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
  expect(await screen.findByText("Сотрудник обновлён")).toBeDefined();
});

it("keeps every resource and the profile values after a failed profile PATCH", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/employees/1" && init?.method === "PATCH") {
        return jsonResponse(409, { message: "Employee already exists" });
      }
      if (String(url) === "/api/employees") return jsonResponse(200, { items: [JANE] });
      if (String(url) === "/api/operators") {
        return jsonResponse(200, { items: [ACTIVE_OPERATOR] });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  const { router, user } = renderPanel(["/employees/1/edit"]);

  await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const fullName = within(panel).getByLabelText("ФИО");
  await user.clear(fullName);
  await user.type(fullName, "Jane Conflict");
  await user.type(within(panel).getByLabelText("Код бейджа"), "BADGE-DRAFT");
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));

  const profile = within(panel).getByRole("region", { name: "Профиль" });
  expect((await within(profile).findByRole("alert")).textContent).toContain(
    "Employee already exists",
  );
  expect((fullName as HTMLInputElement).value).toBe("Jane Conflict");
  expect((within(panel).getByLabelText("Код бейджа") as HTMLInputElement).value).toBe(
    "BADGE-DRAFT",
  );
  expect(within(panel).getByRole("region", { name: "Доступ на станцию" })).toBeDefined();
  expect(router.state.location.pathname).toBe("/employees/1/edit");

  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  expect(within(sectionNav).getByRole("button", { name: /Профиль.*Ошибка/ })).toBeDefined();
});

it("keeps the Profile API marker when validation is corrected until the next API attempt", async () => {
  let patchAttempts = 0;
  let resolveRetry: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url) === "/api/employees/1" && init?.method === "PATCH") {
        patchAttempts += 1;
        if (patchAttempts === 1) {
          return Promise.resolve(jsonResponse(409, { message: "Employee already exists" }));
        }
        return new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        });
      }
      if (String(url) === "/api/employees") {
        return Promise.resolve(jsonResponse(200, { items: [JANE] }));
      }
      if (String(url) === "/api/operators") {
        return Promise.resolve(jsonResponse(200, { items: [ACTIVE_OPERATOR] }));
      }
      return Promise.reject(new Error(`Unexpected request: ${String(url)}`));
    }),
  );
  const { router, user } = renderPanel(["/employees", "/employees/1/edit"]);

  const fullName = await screen.findByLabelText("ФИО");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  const profile = within(panel).getByRole("region", { name: "Профиль" });
  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  const save = within(panel).getByRole("button", { name: "Сохранить" });
  await user.clear(fullName);
  await user.type(fullName, "Jane Conflict");
  await user.click(save);

  expect(await within(profile).findByText("Employee already exists")).toBeDefined();
  expect(within(sectionNav).getByRole("button", { name: /Профиль.*Ошибка/ })).toBeDefined();

  await user.clear(fullName);
  await user.click(save);
  expect(await within(profile).findByText("Укажите ФИО")).toBeDefined();
  await user.type(fullName, "Jane Corrected");
  await waitFor(() => expect(within(profile).queryByText("Укажите ФИО")).toBeNull());

  expect(within(profile).getByText("Employee already exists")).toBeDefined();
  expect(within(sectionNav).getByRole("button", { name: /Профиль.*Ошибка/ })).toBeDefined();

  await user.click(save);
  await waitFor(() => expect(within(profile).queryByText("Employee already exists")).toBeNull());
  expect(within(sectionNav).getByRole("button", { name: /^Профиль$/ })).toBeDefined();

  resolveRetry?.(jsonResponse(200, { ...JANE, fullName: "Jane Corrected" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it("blocks Back after the edit profile becomes dirty until discard is confirmed", async () => {
  stubEmployeeAndOperators();
  const { router, user } = renderPanel(["/employees", "/employees/1/edit"]);

  await user.type(await screen.findByLabelText("ФИО"), " draft");
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/employees/1/edit");
  const confirmation = await screen.findByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Не сохранять" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/employees"));
});

it.each([
  { label: "Код бейджа", value: "DRAFT-BADGE" },
  { label: "ПИН-код", value: "4321" },
])("treats a non-empty $label as dirty while Profile stays clean", async ({ label, value }) => {
  stubEmployeeAndOperators({ operators: label === "ПИН-код" ? [] : [ACTIVE_OPERATOR] });
  const { user } = renderPanel(["/employees/1/edit"]);

  await user.type(await screen.findByLabelText(label), value);
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));

  expect(screen.getByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();
});

it("blocks panel dismissal while a badge mutation is pending and stays open after local success", async () => {
  let resolveIssue: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (String(url) === "/api/employees/1/badges" && init?.method === "POST") {
      return new Promise<Response>((resolve) => {
        resolveIssue = resolve;
      });
    }
    if (String(url) === "/api/employees") {
      return Promise.resolve(jsonResponse(200, { items: [JANE] }));
    }
    if (String(url) === "/api/operators") {
      return Promise.resolve(jsonResponse(200, { items: [ACTIVE_OPERATOR] }));
    }
    return Promise.reject(new Error(`Unexpected request: ${String(url)}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  const { router, user } = renderPanel(["/employees", "/employees/1/edit"]);

  await screen.findByLabelText("Код бейджа");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  await user.type(within(panel).getByLabelText("Код бейджа"), "CCC333");
  await user.click(within(panel).getByRole("button", { name: "Выпустить бейдж" }));

  await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("true"));
  expect(
    (within(panel).getByRole("button", { name: "Закрыть" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (within(panel).getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (within(panel).getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.keyboard("{Escape}");
  fireEvent.mouseDown(document.querySelector<HTMLElement>(".mk-side-panel__scrim")!);
  await router.navigate(-1);
  expect(router.state.location.pathname).toBe("/employees/1/edit");
  expect(screen.queryByRole("alertdialog")).toBeNull();

  resolveIssue?.(jsonResponse(201, JANE));

  await waitFor(() => expect(panel.hasAttribute("aria-busy")).toBe(false));
  expect(router.state.location.pathname).toBe("/employees/1/edit");
  expect((within(panel).getByLabelText("Код бейджа") as HTMLInputElement).value).toBe("");
});

it("blocks panel dismissal while a station-access mutation is pending", async () => {
  let resolveGrant: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url) === "/api/operators/1" && init?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          resolveGrant = resolve;
        });
      }
      if (String(url) === "/api/employees") {
        return Promise.resolve(jsonResponse(200, { items: [JANE] }));
      }
      if (String(url) === "/api/operators") {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
      return Promise.reject(new Error(`Unexpected request: ${String(url)}`));
    }),
  );
  const { router, user } = renderPanel(["/employees", "/employees/1/edit"]);

  await screen.findByLabelText("Табельный номер");
  const panel = screen.getByRole("dialog", { name: "Изменить сотрудника" });
  await user.type(within(panel).getByLabelText("Табельный номер"), "123456");
  await user.type(within(panel).getByLabelText("ПИН-код"), "4321");
  await user.click(within(panel).getByRole("button", { name: "Выдать доступ" }));

  await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("true"));
  await router.navigate(-1);
  expect(router.state.location.pathname).toBe("/employees/1/edit");
  expect(screen.queryByRole("alertdialog")).toBeNull();

  resolveGrant?.(
    jsonResponse(200, {
      employeeId: "1",
      login: "123456",
      active: true,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    }),
  );
  await waitFor(() => expect(panel.hasAttribute("aria-busy")).toBe(false));
  expect(router.state.location.pathname).toBe("/employees/1/edit");
});

it("denies a direct read-only edit URL before privileged edit hooks mount", async () => {
  stubEmployeeAndOperators();
  renderPanel(["/employees/1/edit"], READ_ONLY_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(updateHookMountSpy).not.toHaveBeenCalled();
  expect(operatorsHookMountSpy).not.toHaveBeenCalled();
});
