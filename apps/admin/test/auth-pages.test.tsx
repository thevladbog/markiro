import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
} from "../src/auth/client.js";
import { CreateOrgPage } from "../src/pages/auth/CreateOrg.js";
import { ActivateOwnerPage } from "../src/pages/auth/ActivateOwner.js";
import { LoginPage } from "../src/pages/auth/Login.js";
import { RegisterPage } from "../src/pages/auth/Register.js";
import { ResetPasswordPage } from "../src/pages/auth/ResetPassword.js";
import { SelectOrgPage } from "../src/pages/auth/SelectOrg.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A fully-fake AuthClientLike -- no network, no better-auth internals. */
function createFakeAuthClient(overrides: Partial<AuthClientLike> = {}): AuthClientLike {
  return {
    useSession: () => ({ data: null, isPending: false, error: null }),
    useListOrganizations: () => ({ data: [], isPending: false, error: null }),
    signIn: { email: vi.fn(async () => ({ data: {}, error: null })) },
    signUp: { email: vi.fn(async () => ({ data: {}, error: null })) },
    resetPassword: vi.fn(async () => ({ data: { status: true }, error: null })),
    signOut: vi.fn(async () => ({ data: {}, error: null })),
    organization: {
      create: vi.fn(async () => ({ data: { id: "org_1" }, error: null })),
      list: vi.fn(async () => ({ data: [] as OrganizationSummary[], error: null })),
      setActive: vi.fn(async () => ({ data: {}, error: null })),
    },
    ...overrides,
  };
}

function renderRouted(
  client: AuthClientLike,
  initialPath: string,
  element: ReactElement,
  routePath = initialPath,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthClientProvider client={client}>
          <Routes>
            <Route path={routePath} element={element} />
            <Route path="/" element={<div>SHELL_PLACEHOLDER</div>} />
            <Route path="/login" element={<div>LOGIN_PAGE</div>} />
          </Routes>
        </AuthClientProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("ResetPasswordPage", () => {
  it("sets the first password from the emailed token and returns to sign in", async () => {
    const resetPassword = vi.fn(async () => ({ data: { status: true }, error: null }));
    const client = Object.assign(createFakeAuthClient(), { resetPassword });
    renderRouted(
      client,
      "/reset-password?token=one-time-setup-token",
      <ResetPasswordPage />,
      "/reset-password",
    );

    fireEvent.change(screen.getByLabelText("Новый пароль"), {
      target: { value: "a-secure-password" },
    });
    fireEvent.change(screen.getByLabelText("Повторите пароль"), {
      target: { value: "a-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Установить пароль" }));

    await waitFor(() => {
      expect(resetPassword).toHaveBeenCalledWith({
        newPassword: "a-secure-password",
        token: "one-time-setup-token",
      });
    });
    await screen.findByText("LOGIN_PAGE");
  });

  it("does not show a password form when the activation token is missing", () => {
    renderRouted(
      createFakeAuthClient(),
      "/reset-password",
      <ResetPasswordPage />,
      "/reset-password",
    );

    expect(screen.getByText("Ссылка недействительна")).toBeDefined();
    expect(screen.queryByLabelText("Новый пароль")).toBeNull();
  });
});

describe("ActivateOwnerPage", () => {
  it("sets a password only for a fresh global account", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ hasAccount: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderRouted(
      createFakeAuthClient(),
      "/activate-owner#token=one-time-owner-token",
      <ActivateOwnerPage />,
      "/activate-owner",
    );

    fireEvent.change(await screen.findByLabelText("Новый пароль"), {
      target: { value: "fresh-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Повторите пароль"), {
      target: { value: "fresh-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Активировать доступ" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      token: "one-time-owner-token",
      password: "fresh-password-123",
    });
    await screen.findByText("LOGIN_PAGE");
  });

  it("preserves the password for an existing multi-tenant account", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ hasAccount: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderRouted(
      createFakeAuthClient(),
      "/activate-owner#token=existing-owner-token",
      <ActivateOwnerPage />,
      "/activate-owner",
    );

    expect(await screen.findByText(/текущий пароль останется без изменений/i)).toBeDefined();
    expect(screen.queryByLabelText("Новый пароль")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить и продолжить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      token: "existing-owner-token",
    });
    await screen.findByText("LOGIN_PAGE");
  });
});

describe("LoginPage", () => {
  it("renders labels from the RU dictionary", () => {
    renderRouted(createFakeAuthClient(), "/login", <LoginPage />);
    expect(screen.getByText("Вход")).toBeDefined();
    expect(screen.getByLabelText("Электронная почта")).toBeDefined();
    expect(screen.getByLabelText("Пароль")).toBeDefined();
    expect(screen.getByRole("button", { name: "Войти" })).toBeDefined();
    expect(screen.getByText("Доступ выдаёт администратор организации.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Как получить доступ" })).toBeDefined();
  });

  it("submits credentials through the injected auth client and navigates home", async () => {
    const client = createFakeAuthClient();
    renderRouted(client, "/login", <LoginPage />);

    fireEvent.change(screen.getByLabelText("Электронная почта"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => {
      expect(client.signIn.email).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "hunter2!",
      });
    });
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("shows the server error message when sign-in fails", async () => {
    const client = createFakeAuthClient({
      signIn: {
        email: vi.fn(async () => ({ data: null, error: { message: "Invalid credentials" } })),
      },
    });
    renderRouted(client, "/login", <LoginPage />);

    fireEvent.change(screen.getByLabelText("Электронная почта"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    expect(await screen.findByText("Invalid credentials")).toBeDefined();
  });
});

describe("RegisterPage", () => {
  it("directs users to invitation links without offering free email registration", () => {
    const client = createFakeAuthClient();
    renderRouted(client, "/register", <RegisterPage />);

    expect(screen.getByText("Регистрация доступна по приглашению")).toBeDefined();
    expect(screen.getByRole("link", { name: "Войти" })).toBeDefined();
    expect(screen.queryByLabelText("Электронная почта")).toBeNull();
    expect(screen.queryByRole("button", { name: "Зарегистрироваться" })).toBeNull();
    expect(client.signUp.email).not.toHaveBeenCalled();
  });
});

describe("CreateOrgPage", () => {
  it("clears tenant query data before organization creation can switch the tenant", async () => {
    let resolveCreate!: (value: { data: { id: string }; error: null }) => void;
    const createResult = new Promise<{ data: { id: string }; error: null }>((resolve) => {
      resolveCreate = resolve;
    });
    let cachedTenantDataAtCreateCall: unknown = "CREATE_NOT_CALLED";
    const client = createFakeAuthClient({
      organization: {
        create: vi.fn(() => createResult),
        list: vi.fn(async () => ({ data: [] as OrganizationSummary[], error: null })),
        setActive: vi.fn(async () => ({ data: {}, error: null })),
      },
    });
    const { queryClient } = renderRouted(client, "/org/create", <CreateOrgPage />);
    queryClient.setQueryData(["tenant-secret"], "OLD_ORG_SECRET");
    expect(queryClient.getQueryData(["tenant-secret"])).toBe("OLD_ORG_SECRET");
    vi.mocked(client.organization.create).mockImplementation(() => {
      cachedTenantDataAtCreateCall = queryClient.getQueryData(["tenant-secret"]);
      return createResult;
    });

    fireEvent.change(screen.getByLabelText("Название организации"), {
      target: { value: "Acme Corp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(client.organization.create).toHaveBeenCalledWith({
        name: "Acme Corp",
        slug: "acme-corp",
      });
    });
    expect(cachedTenantDataAtCreateCall).toBeUndefined();
    expect(queryClient.getQueryData(["tenant-secret"])).toBeUndefined();
    expect(screen.queryByText("SHELL_PLACEHOLDER")).toBeNull();

    resolveCreate({ data: { id: "org_1" }, error: null });
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("derives a slug from the name, creates, and activates the organization", async () => {
    const client = createFakeAuthClient();
    renderRouted(client, "/org/create", <CreateOrgPage />);

    fireEvent.change(screen.getByLabelText("Название организации"), {
      target: { value: "Acme Corp" },
    });
    const slugInput = screen.getByLabelText("Короткий идентификатор (slug)") as HTMLInputElement;
    expect(slugInput.value).toBe("acme-corp");

    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(client.organization.create).toHaveBeenCalledWith({
        name: "Acme Corp",
        slug: "acme-corp",
      });
    });
    expect(client.organization.setActive).toHaveBeenCalledWith({ organizationId: "org_1" });
    await screen.findByText("SHELL_PLACEHOLDER");
  });
});

describe("SelectOrgPage", () => {
  it("lists organizations from the auth client and activates the chosen one", async () => {
    let resolveSetActive!: (value: { data: unknown; error: null }) => void;
    const setActiveResult = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveSetActive = resolve;
    });
    const client = createFakeAuthClient({
      organization: {
        create: vi.fn(),
        setActive: vi.fn(() => setActiveResult),
        list: vi.fn(async () => ({
          data: [{ id: "org_1", name: "Acme Corp", slug: "acme-corp" }],
          error: null,
        })),
      },
    });
    const { queryClient } = renderRouted(client, "/org/select", <SelectOrgPage />);
    queryClient.setQueryData(["tenant-secret"], "OLD_ORG_SECRET");

    expect(await screen.findByText("Acme Corp")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));

    await waitFor(() => {
      expect(client.organization.setActive).toHaveBeenCalledWith({ organizationId: "org_1" });
    });
    expect(queryClient.getQueryData(["tenant-secret"])).toBeUndefined();
    expect(screen.queryByText("SHELL_PLACEHOLDER")).toBeNull();

    resolveSetActive({ data: {}, error: null });
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("shows an empty state when the user has no organizations", async () => {
    renderRouted(createFakeAuthClient(), "/org/select", <SelectOrgPage />);
    expect(await screen.findByText("У вас пока нет организаций.")).toBeDefined();
  });
});
