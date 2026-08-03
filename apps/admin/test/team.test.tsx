import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { AuthClientProvider, type AuthClientLike } from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { TeamPage } from "../src/pages/team/TeamPage.js";

const TEAM = {
  members: [
    {
      id: "member_self",
      userId: "user_1",
      email: "elena@example.com",
      firstName: "Елена",
      lastName: "Ким",
      middleName: null,
      avatarAssetId: null,
      role: "admin",
      position: "Руководитель смены",
      employee: {
        id: "11111111-1111-4111-8111-111111111111",
        fullName: "Елена Ким",
        status: "active",
        operatorAccess: true,
      },
      createdAt: "2026-08-04T00:00:00.000Z",
    },
    {
      id: "member_owner",
      userId: "user_owner",
      email: "owner@example.com",
      firstName: "Иван",
      lastName: "Петров",
      middleName: null,
      avatarAssetId: "asset_1",
      role: "owner",
      position: null,
      employee: {
        id: "33333333-3333-4333-8333-333333333333",
        fullName: "Мария Орлова",
        status: "archived",
        operatorAccess: false,
      },
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "member_manager",
      userId: "user_2",
      email: "anna@example.com",
      firstName: "Анна",
      lastName: "Соколова",
      middleName: null,
      avatarAssetId: null,
      role: "manager",
      position: "Мастер смены",
      employee: null,
      createdAt: "2026-08-03T00:00:00.000Z",
    },
  ],
  invitations: [
    {
      id: "invite_1",
      email: "manager@example.com",
      role: "manager",
      position: "Начальник производства",
      accessStatus: "pending",
      expiresAt: "2026-08-10T00:00:00.000Z",
      employee: null,
      delivery: { id: "delivery_1", status: "failed", errorCategory: "smtp" },
    },
  ],
};

const EMPLOYEES = {
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      fullName: "Елена Ким",
      role: null,
      status: "active",
      badges: [],
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      fullName: "Олег Серов",
      role: "Оператор",
      status: "active",
      badges: [],
      createdAt: "2026-08-02T00:00:00.000Z",
    },
  ],
};

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : "",
    json: async () => body,
  } as Response;
}

function authClient(): AuthClientLike {
  return {
    useSession: () => ({
      data: {
        session: { activeOrganizationId: "org_1" },
        user: { id: "user_1", email: "elena@example.com", name: "Елена Ким" },
      },
      isPending: false,
      error: null,
    }),
    useListOrganizations: () => ({ data: [], isPending: false, error: null }),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    organization: { create: vi.fn(), list: vi.fn(), setActive: vi.fn() },
  };
}

function renderTeam(fetchImplementation: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(fetchImplementation));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={authClient()}>
          <TeamPage />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

describe("TeamPage", () => {
  it("renders members and invitation delivery state without exposing self or owner actions", async () => {
    renderTeam(async (input) => {
      if (String(input).endsWith("/api/team")) return response(200, TEAM);
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    expect(await screen.findByRole("heading", { name: "Команда" })).toBeDefined();
    expect(await screen.findByText("Елена Ким")).toBeDefined();
    expect(screen.getByText("Руководитель смены")).toBeDefined();
    expect(screen.getByText("Есть доступ оператора")).toBeDefined();
    expect(screen.getByText("manager@example.com")).toBeDefined();
    expect(screen.getByText("Ошибка отправки")).toBeDefined();
    expect(screen.getByText("Сотрудник: Мария Орлова")).toBeDefined();
    expect(screen.getByText("Сотрудник в архиве")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Изменить Елена Ким/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Изменить Иван Петров/ })).toBeNull();
  });

  it("offers only unclaimed active employees and creates an invitation", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    renderTeam(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/team") && !init?.method) return response(200, TEAM);
      if (url.endsWith("/api/employees?status=active")) return response(200, EMPLOYEES);
      if (url.endsWith("/api/team/invitations") && init?.method === "POST") {
        return response(201, TEAM.invitations[0]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Пригласить" }));
    expect(await screen.findByRole("option", { name: "Олег Серов — Оператор" })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Елена Ким/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Электронная почта"), {
      target: { value: "new.manager@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Должность"), {
      target: { value: "Начальник цеха" },
    });
    fireEvent.change(screen.getByLabelText("Сотрудник"), {
      target: { value: "22222222-2222-4222-8222-222222222222" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить приглашение" }));

    await waitFor(() => {
      const request = requests.find(
        ({ url, init }) => url.endsWith("/api/team/invitations") && init?.method === "POST",
      );
      expect(JSON.parse(String(request?.init?.body))).toEqual({
        email: "new.manager@example.com",
        role: "manager",
        position: "Начальник цеха",
        employeeId: "22222222-2222-4222-8222-222222222222",
      });
    });
  });

  it("keeps resend pending and retries a delivery_in_flight conflict once", async () => {
    let resendCalls = 0;
    renderTeam(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/team") && !init?.method) return response(200, TEAM);
      if (url.endsWith("/api/team/invitations/invite_1/resend")) {
        resendCalls += 1;
        if (resendCalls === 1) return response(409, { code: "delivery_in_flight" });
        return response(200, {
          ...TEAM.invitations[0],
          delivery: { id: "delivery_2", status: "queued", errorCategory: null },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const resend = await screen.findByRole("button", { name: "Отправить снова" });
    vi.useFakeTimers();
    fireEvent.click(resend);
    await vi.advanceTimersByTimeAsync(0);
    expect(resendCalls).toBe(1);
    expect((resend as HTMLButtonElement).disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(resendCalls).toBe(2);
  });

  it("does not offer resend or cancel actions for an expired invitation", async () => {
    renderTeam(async (input) => {
      if (String(input).endsWith("/api/team")) {
        return response(200, {
          ...TEAM,
          invitations: [{ ...TEAM.invitations[0], accessStatus: "expired" }],
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    expect(await screen.findByText("Действия недоступны")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Отправить снова" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
  });

  it("resets canceled member edits and performs update, employee link, and confirmed removal", async () => {
    const mutations: Array<{ url: string; init: RequestInit | undefined }> = [];
    renderTeam(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/team") && !init?.method) return response(200, TEAM);
      if (url.endsWith("/api/employees?status=active")) return response(200, EMPLOYEES);
      if (init?.method) mutations.push({ url, init });
      if (url.endsWith("/api/team/members/member_manager") && init?.method === "PATCH") {
        return response(200, { ...TEAM.members[2], role: "admin", position: "Начальник смены" });
      }
      if (url.endsWith("/api/team/members/member_manager/employee") && init?.method === "PUT") {
        return response(200, { ...TEAM.members[2], employee: EMPLOYEES.items[1] });
      }
      if (url.endsWith("/api/team/members/member_manager") && init?.method === "DELETE") {
        return response(204);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const edit = await screen.findByRole("button", { name: "Изменить Анна Соколова" });
    fireEvent.click(edit);
    fireEvent.change(await screen.findByLabelText("Роль"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Должность"), { target: { value: "Черновик" } });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));

    fireEvent.click(edit);
    expect((screen.getByLabelText("Роль") as HTMLSelectElement).value).toBe("manager");
    expect((screen.getByLabelText("Должность") as HTMLInputElement).value).toBe("Мастер смены");
    fireEvent.change(screen.getByLabelText("Роль"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Должность"), {
      target: { value: "Начальник смены" },
    });
    fireEvent.change(screen.getByLabelText("Сотрудник"), {
      target: { value: "22222222-2222-4222-8222-222222222222" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(mutations.map(({ url, init }) => [url, init?.method])).toEqual([
        ["/api/team/members/member_manager", "PATCH"],
        ["/api/team/members/member_manager/employee", "PUT"],
      ]);
    });
    expect(JSON.parse(String(mutations[0]?.init?.body))).toEqual({
      role: "admin",
      position: "Начальник смены",
    });
    expect(JSON.parse(String(mutations[1]?.init?.body))).toEqual({
      employeeId: "22222222-2222-4222-8222-222222222222",
    });

    fireEvent.click(screen.getByRole("button", { name: "Удалить Анна Соколова" }));
    let dialog = screen.getByRole("dialog", { name: "Удалить участника?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(mutations).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Удалить Анна Соколова" }));
    dialog = screen.getByRole("dialog", { name: "Удалить участника?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(mutations.at(-1)?.init?.method).toBe("DELETE"));
  });

  it("requires confirmation before canceling an invitation", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    renderTeam(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/team") && !init?.method) return response(200, TEAM);
      if (url.endsWith("/api/team/invitations/invite_1") && init?.method === "DELETE") {
        requests.push({ url, init });
        return response(204);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Отменить" }));
    let dialog = screen.getByRole("dialog", { name: "Отменить приглашение?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(requests).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    dialog = screen.getByRole("dialog", { name: "Отменить приглашение?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(requests).toHaveLength(1));
  });

  it("renders a localized warning while delivery is retrying", async () => {
    renderTeam(async (input) => {
      if (String(input).endsWith("/api/team")) {
        return response(200, {
          ...TEAM,
          invitations: [
            {
              ...TEAM.invitations[0],
              delivery: { id: "delivery_2", status: "retrying", errorCategory: null },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    expect(await screen.findByText("Повторная отправка")).toBeDefined();
  });
});
