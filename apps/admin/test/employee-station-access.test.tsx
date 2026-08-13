import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmployeeStationAccessSection,
  type EmployeeStationAccessSectionProps,
} from "../src/pages/employees/EmployeeStationAccessSection.js";
import type { EmployeeDto } from "../src/pages/employees/api.js";
import {
  OPERATORS_QUERY_KEY,
  type OperatorListItemDto,
  type StationAccessDto,
} from "../src/pages/employees/station-access-api.js";
import { jsonResponse } from "./helpers/http.js";

const JANE: EmployeeDto = {
  id: "1",
  fullName: "Jane Doe",
  role: "Кассир",
  status: "active",
  pickupPolicy: { limitMode: "limited", dayLimit: 5, canWriteoff: false },
  badges: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const EXISTING_ACCESS: OperatorListItemDto = {
  employeeId: "1",
  fullName: "Jane Doe",
  role: "Кассир",
  login: "123456",
  active: true,
  hasBadge: false,
};

const UPDATED_ACCESS: StationAccessDto = {
  employeeId: "1",
  login: "123456",
  active: true,
  createdAt: "2026-01-03T00:00:00.000Z",
  updatedAt: "2026-01-04T00:00:00.000Z",
};

function makeReporters() {
  return {
    onDirtyChange: vi.fn(),
    onBusyChange: vi.fn(),
    onErrorChange: vi.fn(),
    onStatusChange: vi.fn(),
  };
}

function stubOperators(handler: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url === "/api/operators"
        ? Promise.resolve(handler())
        : Promise.resolve(jsonResponse(500, { message: `Unexpected request: ${url}` })),
    ),
  );
}

function stubExistingAccess(overrides: Partial<OperatorListItemDto> = {}) {
  stubOperators(() => jsonResponse(200, { items: [{ ...EXISTING_ACCESS, ...overrides }] }));
}

function renderStationAccess(
  employee: EmployeeDto = JANE,
  reporters: Pick<
    EmployeeStationAccessSectionProps,
    "onDirtyChange" | "onBusyChange" | "onErrorChange" | "onStatusChange"
  > = makeReporters(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...reporters,
    ...render(
      <QueryClientProvider client={queryClient}>
        <EmployeeStationAccessSection employee={employee} {...reporters} />
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EmployeeStationAccessSection query states", () => {
  it("reports loading and withholds Grant while operators are pending", async () => {
    stubOperators(() => new Promise<Response>(() => {}));
    const reporters = makeReporters();
    renderStationAccess(JANE, reporters);

    const section = screen.getByRole("region", { name: "Доступ на станцию" });
    expect(within(section).getByText("Загрузка статуса доступа на станцию…")).toBeDefined();
    expect(within(section).getByRole("status").textContent).toContain(
      "Загрузка статуса доступа на станцию…",
    );
    expect(within(section).queryByRole("button", { name: "Выдать доступ" })).toBeNull();
    await waitFor(() => expect(reporters.onStatusChange).toHaveBeenLastCalledWith("loading"));
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(false);
  });

  it("does not expose Grant until operators Retry confirms absence", async () => {
    let attempts = 0;
    stubOperators(() => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(500, { message: "Unavailable" })
        : jsonResponse(200, { items: [] });
    });
    const reporters = makeReporters();
    renderStationAccess(JANE, reporters);
    const user = userEvent.setup();
    const section = await screen.findByRole("region", { name: "Доступ на станцию" });

    expect(await within(section).findByRole("alert")).toBeDefined();
    expect(within(section).queryByRole("button", { name: "Выдать доступ" })).toBeNull();
    expect(reporters.onStatusChange).toHaveBeenLastCalledWith("error");
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(true);

    await user.click(within(section).getByRole("button", { name: "Повторить" }));

    expect(await within(section).findByRole("button", { name: "Выдать доступ" })).toBeDefined();
    expect(within(section).getByText("Доступ на линейную станцию не выдан")).toBeDefined();
    expect(reporters.onStatusChange).toHaveBeenLastCalledWith("none");
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(false);
  });

  it.each([
    { active: true, badge: "Активен", action: "Отключить", status: "active" },
    { active: false, badge: "Отключён", action: "Включить", status: "disabled" },
  ] as const)("renders and reports $status access", async ({ active, badge, action, status }) => {
    stubExistingAccess({ active });
    const reporters = makeReporters();
    renderStationAccess(JANE, reporters);
    const section = await screen.findByRole("region", { name: "Доступ на станцию" });

    expect(await within(section).findByText("Табельный номер 123456")).toBeDefined();
    expect(within(section).getByText(badge)).toBeDefined();
    expect(within(section).getByRole("button", { name: action })).toBeDefined();
    expect(within(section).queryByLabelText("Табельный номер")).toBeNull();
    expect(reporters.onStatusChange).toHaveBeenLastCalledWith(status);
  });
});

describe("EmployeeStationAccessSection mutations", () => {
  it("surfaces and discards an absent-access draft when access appears", async () => {
    stubOperators(() => jsonResponse(200, { items: [] }));
    const reporters = makeReporters();
    const { queryClient } = renderStationAccess(JANE, reporters);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Табельный номер"), "654321");
    await user.type(screen.getByLabelText("ПИН-код"), "4321");

    await act(async () => {
      queryClient.setQueryData(OPERATORS_QUERY_KEY, [EXISTING_ACCESS]);
    });

    const section = screen.getByRole("region", { name: "Доступ на станцию" });
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "Черновик доступа конфликтует с уже выданным доступом",
    );
    await user.click(within(section).getByRole("button", { name: "Отменить черновик" }));

    await waitFor(() => expect(reporters.onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(within(section).queryByRole("button", { name: "Отменить черновик" })).toBeNull();

    await user.type(within(section).getByLabelText("ПИН-код"), "9876");
    expect(within(section).queryByRole("button", { name: "Отменить черновик" })).toBeNull();
  });

  it("disables every existing-access mutation control while a toggle is pending", async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/operators/1") {
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { items: [EXISTING_ACCESS] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStationAccess();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("ПИН-код"), "4321");
    await user.click(screen.getByRole("button", { name: "Отключить" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/operators/1",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ active: false }) }),
      ),
    );
    expect(screen.getByRole("button", { name: "Отключить" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Сменить ПИН" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Убрать доступ" }).hasAttribute("disabled")).toBe(
      true,
    );

    resolvePatch?.(jsonResponse(200, { ...UPDATED_ACCESS, active: false }));
  });

  it("keeps grant and PIN-reset values out of the real MutationCache", async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    let resolvePatch: ((response: Response) => void) | undefined;
    let hasAccess = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && url === "/api/operators/1") {
        return new Promise<Response>((resolve) => {
          resolvePut = resolve;
        });
      }
      if (init?.method === "PATCH" && url === "/api/operators/1") {
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { items: hasAccess ? [EXISTING_ACCESS] : [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, unmount } = renderStationAccess();
    const user = userEvent.setup();
    const grantPin = "CACHE-SECRET-GRANT-PIN";

    await user.type(await screen.findByLabelText("Табельный номер"), "123456");
    await user.type(screen.getByLabelText("ПИН-код"), grantPin);
    await user.click(screen.getByRole("button", { name: "Выдать доступ" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/operators/1",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .some((mutation) => JSON.stringify(mutation.state).includes(grantPin)),
    ).toBe(false);

    resolvePut?.(jsonResponse(200, UPDATED_ACCESS));
    hasAccess = true;
    unmount();

    const resetPin = "CACHE-SECRET-RESET-PIN";
    const { queryClient: resetQueryClient } = renderStationAccess();
    await user.type(await screen.findByLabelText("ПИН-код"), resetPin);
    await user.click(screen.getByRole("button", { name: "Сменить ПИН" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/operators/1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(
      resetQueryClient
        .getMutationCache()
        .getAll()
        .some((mutation) => JSON.stringify(mutation.state).includes(resetPin)),
    ).toBe(false);

    resolvePatch?.(jsonResponse(200, UPDATED_ACCESS));
  });

  it("PUTs login and PIN, reports transitions, and clears both only after success", async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && url === "/api/operators/1") {
        return new Promise<Response>((resolve) => {
          resolvePut = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const reporters = makeReporters();
    renderStationAccess(JANE, reporters);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Табельный номер"), " 123456 ");
    await user.type(screen.getByLabelText("ПИН-код"), " 4321 ");
    await user.click(screen.getByRole("button", { name: "Выдать доступ" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operators/1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ login: "123456", pin: "4321" }),
      }),
    );
    await waitFor(() => expect(reporters.onBusyChange).toHaveBeenCalledWith(true));
    expect(reporters.onDirtyChange).toHaveBeenCalledWith(true);
    expect((screen.getByLabelText("Табельный номер") as HTMLInputElement).value).toBe(" 123456 ");
    expect((screen.getByLabelText("ПИН-код") as HTMLInputElement).value).toBe(" 4321 ");

    resolvePut?.(jsonResponse(200, UPDATED_ACCESS));

    await waitFor(() => {
      expect((screen.getByLabelText("Табельный номер") as HTMLInputElement).value).toBe("");
      expect((screen.getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("");
      expect(reporters.onDirtyChange).toHaveBeenLastCalledWith(false);
      expect(reporters.onBusyChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("preserves login and PIN with a persistent owning-section error after failed grant", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "PUT" && url === "/api/operators/1"
        ? jsonResponse(409, { message: "Personnel number already used" })
        : jsonResponse(200, { items: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reporters = makeReporters();
    renderStationAccess(JANE, reporters);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Табельный номер"), "123456");
    await user.type(screen.getByLabelText("ПИН-код"), "4321");
    await user.click(screen.getByRole("button", { name: "Выдать доступ" }));

    const section = screen.getByRole("region", { name: "Доступ на станцию" });
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "Personnel number already used",
    );
    expect((screen.getByLabelText("Табельный номер") as HTMLInputElement).value).toBe("123456");
    expect((screen.getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("4321");
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(true);
  });

  it("preserves PIN and PATCHes only pin after a failed reset", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/operators/1") {
        return jsonResponse(409, { message: "PIN policy rejected" });
      }
      return jsonResponse(200, { items: [EXISTING_ACCESS] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reporters = makeReporters();
    renderStationAccess(JANE, reporters);
    const user = userEvent.setup();

    const pinInput = await screen.findByLabelText("ПИН-код");
    expect(pinInput.getAttribute("type")).toBe("password");
    expect(pinInput.getAttribute("inputmode")).toBe("numeric");
    await user.type(pinInput, "9999");
    await user.click(screen.getByRole("button", { name: "Сменить ПИН" }));

    const section = screen.getByRole("region", { name: "Доступ на станцию" });
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "PIN policy rejected",
    );
    expect((screen.getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("9999");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operators/1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ pin: "9999" }) }),
    );
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(true);
  });

  it.each([
    { active: true, action: "Отключить", nextActive: false },
    { active: false, action: "Включить", nextActive: true },
  ])("PATCHes only active when using $action", async ({ active, action, nextActive }) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/operators/1") {
        return jsonResponse(200, { ...UPDATED_ACCESS, active: nextActive });
      }
      return jsonResponse(200, { items: [{ ...EXISTING_ACCESS, active }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStationAccess();

    await userEvent.setup().click(await screen.findByRole("button", { name: action }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/operators/1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ active: nextActive }),
        }),
      ),
    );
  });

  it("uses a translated persistent fallback when an access mutation has no API message", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/operators/1") {
        throw new TypeError("network down");
      }
      return jsonResponse(200, { items: [EXISTING_ACCESS] });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStationAccess();

    await userEvent.setup().click(await screen.findByRole("button", { name: "Отключить" }));

    const section = screen.getByRole("region", { name: "Доступ на станцию" });
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "Не удалось обновить доступ на станцию",
    );
  });

  it("requires destructive confirmation and keeps a failed revoke open with its own error", async () => {
    let resolveDelete: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && url === "/api/operators/1") {
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { items: [EXISTING_ACCESS] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const reporters = makeReporters();
    renderStationAccess(JANE, reporters);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Убрать доступ" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    const dialog = screen.getByRole("alertdialog", { name: "Убрать доступ на станцию?" });
    await user.click(within(dialog).getByRole("button", { name: "Убрать доступ" }));

    await waitFor(() => expect(reporters.onBusyChange).toHaveBeenCalledWith(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operators/1",
      expect.objectContaining({ method: "DELETE" }),
    );
    const deleteInit = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")?.[1];
    expect(deleteInit).not.toHaveProperty("body");

    resolveDelete?.(jsonResponse(409, { message: "Operator has an active shift" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Operator has an active shift",
    );
    expect(screen.getByRole("alertdialog", { name: "Убрать доступ на станцию?" })).toBeDefined();
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(reporters.onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("closes the confirmation after a successful DELETE", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" && url === "/api/operators/1"
        ? jsonResponse(204, undefined)
        : jsonResponse(200, { items: [EXISTING_ACCESS] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderStationAccess();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Убрать доступ" }));
    const dialog = screen.getByRole("alertdialog", { name: "Убрать доступ на станцию?" });
    await user.click(within(dialog).getByRole("button", { name: "Убрать доступ" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "Убрать доступ на станцию?" })).toBeNull(),
    );
  });
});
