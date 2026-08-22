import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore, type ReactElement } from "react";
import { createMemoryRouter, MemoryRouter, Route, Routes, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { AuthQueryBoundary } from "../src/query/AuthQueryBoundary.js";
import { CreateOrgPage } from "../src/pages/auth/CreateOrg.js";
import { ActivateOwnerPage } from "../src/pages/auth/ActivateOwner.js";
import { LoginPage } from "../src/pages/auth/Login.js";
import { RegisterPage } from "../src/pages/auth/Register.js";
import { ResetPasswordPage } from "../src/pages/auth/ResetPassword.js";
import { SelectOrgPage } from "../src/pages/auth/SelectOrg.js";

afterEach(async () => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  await i18n.changeLanguage("ru");
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
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <AuthClientProvider client={client}>
            <Routes>
              <Route path={routePath} element={element} />
              <Route path="/" element={<div>SHELL_PLACEHOLDER</div>} />
              <Route path="/login" element={<div>LOGIN_PAGE</div>} />
            </Routes>
          </AuthClientProvider>
        </MemoryRouter>
      </ThemeProvider>
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
    expect(screen.getByRole("heading", { level: 1, name: "Войти" })).toBeDefined();
    expect(screen.getByLabelText("Электронная почта")).toBeDefined();
    expect(screen.getByLabelText("Пароль")).toBeDefined();
    expect(screen.getByRole("button", { name: "Войти" })).toBeDefined();
    expect(screen.getByText("Доступ выдаёт администратор организации.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Как получить доступ" })).toBeDefined();
  });

  it("renders the approved Markiro login shell and local date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T09:00:00+03:00"));

    renderRouted(createFakeAuthClient(), "/login", <LoginPage />);

    expect(screen.getAllByRole("img", { name: "Маркиро" })).toHaveLength(2);
    const mobileLogo = document.querySelector(".mk-login-page__mobile-logo");
    expect(mobileLogo?.getAttribute("role")).toBe("img");
    expect(mobileLogo?.getAttribute("aria-label")).toBe("Маркиро");
    expect(mobileLogo?.hasAttribute("aria-hidden")).toBe(false);
    expect(Array.from(mobileLogo?.querySelectorAll("img") ?? []).map((image) => image.alt)).toEqual(
      ["", ""],
    );
    expect(screen.getByRole("heading", { level: 1, name: "Войти" })).toBeDefined();
    expect(screen.getByText("Производство видно целиком.")).toBeDefined();
    expect(screen.getByText("Смены, коды и агрегация — в одном рабочем кабинете.")).toBeDefined();
    const date = screen.getByText("08.08.2026").closest("time");
    expect(date).not.toBeNull();
    expect(date?.getAttribute("datetime")).toBe("2026-08-08");
    expect(date?.textContent).toBe("08.08.2026");
    expect(screen.getByRole("main")).toBeDefined();
  });

  it("changes language from the public login header", async () => {
    renderRouted(createFakeAuthClient(), "/login", <LoginPage />);

    expect(document.documentElement.lang).toBe("ru");
    fireEvent.click(screen.getByRole("button", { name: "Переключить язык" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    expect(screen.getByText("See production as a whole.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Switch language" })).toBeDefined();
    expect(document.documentElement.lang).toBe("en");
  });

  it("cycles the persisted theme preference", async () => {
    renderRouted(createFakeAuthClient(), "/login", <LoginPage />);
    const themeButton = screen.getByRole("button", { name: /Переключить тему/ });

    expect(themeButton.textContent).toBe("Системная тема");
    fireEvent.click(themeButton);

    await waitFor(() => expect(themeButton.textContent).toBe("Светлая тема"));
    expect(localStorage.getItem("markiro.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
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

  it("refreshes the session before navigating after sign-in", async () => {
    let resolveRefresh!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const client = createFakeAuthClient({
      useSession: () => ({ data: null, isPending: false, error: null, refetch: refresh }),
    });
    renderRouted(client, "/login", <LoginPage />);

    fireEvent.change(screen.getByLabelText("Электронная почта"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("SHELL_PLACEHOLDER")).toBeNull();

    resolveRefresh();
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("toggles password visibility without changing its value", () => {
    renderRouted(createFakeAuthClient(), "/login", <LoginPage />);
    const password = screen.getByLabelText("Пароль") as HTMLInputElement;
    fireEvent.change(password, { target: { value: "hunter2!" } });

    expect(password.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Показать пароль" }));
    expect(password.type).toBe("text");
    expect(password.value).toBe("hunter2!");
    fireEvent.click(screen.getByRole("button", { name: "Скрыть пароль" }));
    expect(password.type).toBe("password");
  });

  it("shows only the spinner while one sign-in request is pending", async () => {
    let resolveSignIn!: (value: { data: object; error: null }) => void;
    const pending = new Promise<{ data: object; error: null }>((resolve) => {
      resolveSignIn = resolve;
    });
    const signIn = vi.fn(() => pending);
    const client = createFakeAuthClient({ signIn: { email: signIn } });
    const { container } = renderRouted(client, "/login", <LoginPage />);

    fireEvent.change(screen.getByLabelText("Электронная почта"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    const pendingButton = await screen.findByRole("button", { name: "Выполняется вход" });
    expect(pendingButton.hasAttribute("disabled")).toBe(true);
    expect(within(pendingButton).queryByText("Войти")).toBeNull();
    expect(pendingButton.querySelector(".mk-spin")).not.toBeNull();
    fireEvent.click(pendingButton);
    expect(signIn).toHaveBeenCalledTimes(1);

    resolveSignIn({ data: {}, error: null });
    await screen.findByText("SHELL_PLACEHOLDER");
    expect(container.querySelector(".mk-spin")).toBeNull();
  });

  it("shows the server error and keeps credentials after a failed sign-in", async () => {
    const client = createFakeAuthClient({
      signIn: {
        email: vi.fn(async () => ({ data: null, error: { message: "Invalid credentials" } })),
      },
    });
    renderRouted(client, "/login", <LoginPage />);
    const email = screen.getByLabelText("Электронная почта") as HTMLInputElement;
    const password = screen.getByLabelText("Пароль") as HTMLInputElement;
    fireEvent.change(email, { target: { value: "user@example.com" } });
    fireEvent.change(password, { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Invalid credentials");
    expect(email.value).toBe("user@example.com");
    expect(password.value).toBe("hunter2!");
  });

  it("blocks invalid credentials and keeps both errors associated with their fields", async () => {
    const client = createFakeAuthClient();
    renderRouted(client, "/login", <LoginPage />);
    const email = screen.getByLabelText("Электронная почта") as HTMLInputElement;
    const password = screen.getByLabelText("Пароль") as HTMLInputElement;

    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => {
      expect(email.getAttribute("aria-invalid")).toBe("true");
      expect(password.getAttribute("aria-invalid")).toBe("true");
    });
    expect(client.signIn.email).not.toHaveBeenCalled();

    const emailErrorId = email.getAttribute("aria-describedby");
    const passwordErrorId = password.getAttribute("aria-describedby");
    expect(emailErrorId).not.toBeNull();
    expect(passwordErrorId).not.toBeNull();
    const emailError = emailErrorId === null ? null : document.getElementById(emailErrorId);
    const passwordError =
      passwordErrorId === null ? null : document.getElementById(passwordErrorId);
    expect(emailError?.textContent?.trim()).toBeTruthy();
    expect(passwordError?.textContent?.trim()).toBeTruthy();
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
  it("presents each organization as one descriptive action", async () => {
    const client = createFakeAuthClient({
      useSession: () => ({
        data: {
          session: { activeOrganizationId: null },
          user: { id: "user_1", email: "user@example.com" },
        },
        isPending: false,
        error: null,
      }),
      organization: {
        create: vi.fn(),
        setActive: vi.fn(async () => ({ data: {}, error: null })),
        list: vi.fn(async () => ({
          data: [{ id: "org_1", name: "Acme Corp", slug: "acme-corp" }],
          error: null,
        })),
      },
    });

    renderRouted(client, "/org/select", <SelectOrgPage />);

    expect(
      await screen.findByRole("button", { name: "Открыть организацию Acme Corp" }),
    ).toBeDefined();
    expect(screen.getByText("acme-corp")).toBeDefined();
  });

  it("lists organizations from the auth client and activates the chosen one", async () => {
    let session: SessionData = {
      session: { activeOrganizationId: null },
      user: { id: "user_1", email: "user@example.com" },
    };
    const listeners = new Set<() => void>();
    let resolveSetActive!: (value: { data: unknown; error: null }) => void;
    const setActiveResult = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveSetActive = (value) => {
        session = { ...session, session: { activeOrganizationId: "org_1" } };
        listeners.forEach((listener) => listener());
        resolve(value);
      };
    });
    const client = createFakeAuthClient({
      useSession: () => {
        const observedSession = useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          () => session,
          () => session,
        );
        return { data: observedSession, isPending: false, error: null };
      },
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

    fireEvent.click(screen.getByRole("button", { name: "Открыть организацию Acme Corp" }));

    await waitFor(() => {
      expect(client.organization.setActive).toHaveBeenCalledWith({ organizationId: "org_1" });
    });
    expect(queryClient.getQueryData(["tenant-secret"])).toBeUndefined();
    expect(screen.queryByText("SHELL_PLACEHOLDER")).toBeNull();

    resolveSetActive({ data: {}, error: null });
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("waits for the selected organization to appear in the session before entering the shell", async () => {
    let session: SessionData = {
      session: { activeOrganizationId: null },
      user: { id: "user_1", email: "user@example.com" },
    };
    const listeners = new Set<() => void>();
    const client = createFakeAuthClient({
      useSession: () => {
        const observedSession = useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          () => session,
          () => session,
        );
        return {
          data: observedSession,
          isPending: false,
          error: null,
          refetch: vi.fn(async () => undefined),
        };
      },
      organization: {
        create: vi.fn(),
        list: vi.fn(async () => ({
          data: [{ id: "org_1", name: "Acme Corp", slug: "acme-corp" }],
          error: null,
        })),
        setActive: vi.fn(async () => ({ data: {}, error: null })),
      },
    });
    renderRouted(client, "/org/select", <SelectOrgPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Открыть организацию Acme Corp" }));

    await waitFor(() => expect(client.organization.setActive).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("SHELL_PLACEHOLDER")).toBeNull();

    act(() => {
      session = {
        ...session,
        session: { activeOrganizationId: "org_1" },
      };
      listeners.forEach((listener) => listener());
    });
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("enters the shell on the first selection despite the identity-keyed remount", async () => {
    // Reproduces the production wiring: AuthQueryBoundary remounts the whole
    // router subtree when the session identity gains the active organization,
    // which used to wipe the page state holding the pending navigation.
    let session: SessionData = {
      session: { activeOrganizationId: null },
      user: { id: "user_1", email: "user@example.com" },
    };
    const listeners = new Set<() => void>();
    const client = createFakeAuthClient({
      useSession: () => {
        const observedSession = useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          () => session,
          () => session,
        );
        return { data: observedSession, isPending: false, error: null };
      },
      organization: {
        create: vi.fn(),
        list: vi.fn(async () => ({
          data: [{ id: "org_1", name: "Acme Corp", slug: "acme-corp" }],
          error: null,
        })),
        setActive: vi.fn(async () => ({ data: {}, error: null })),
      },
    });
    const router = createMemoryRouter(
      [
        { path: "/org/select", element: <SelectOrgPage /> },
        { path: "/", element: <div>SHELL_PLACEHOLDER</div> },
      ],
      { initialEntries: ["/org/select"] },
    );
    render(
      <ThemeProvider>
        <AuthClientProvider client={client}>
          <AuthQueryBoundary>
            <RouterProvider router={router} />
          </AuthQueryBoundary>
        </AuthClientProvider>
      </ThemeProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Открыть организацию Acme Corp" }));
    await waitFor(() => expect(client.organization.setActive).toHaveBeenCalledTimes(1));

    act(() => {
      session = { ...session, session: { activeOrganizationId: "org_1" } };
      listeners.forEach((listener) => listener());
    });
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("shows an empty state when the user has no organizations", async () => {
    renderRouted(createFakeAuthClient(), "/org/select", <SelectOrgPage />);
    expect(await screen.findByText("У вас пока нет организаций.")).toBeDefined();
  });
});
