import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider, RequireCapability } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import type * as EmployeesApiModule from "../src/pages/employees/api.js";
import { EmployeeCreatePanelRoute } from "../src/pages/employees/EmployeePanelRoute.js";
import { EmployeesPage } from "../src/pages/employees/index.js";

const { createHookMountSpy } = vi.hoisted(() => ({ createHookMountSpy: vi.fn() }));

vi.mock("../src/pages/employees/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EmployeesApiModule>();
  return {
    ...actual,
    useCreateEmployee: () => {
      createHookMountSpy();
      return actual.useCreateEmployee();
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPanel(
  initialEntries: string[] = ["/employees"],
  access: AccessDocument = WRITE_ACCESS,
) {
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
      </Route>,
    ),
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={access}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { router, user };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  createHookMountSpy.mockClear();
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
