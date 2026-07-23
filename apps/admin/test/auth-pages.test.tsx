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
import { LoginPage } from "../src/pages/auth/Login.js";
import { RegisterPage } from "../src/pages/auth/Register.js";
import { SelectOrgPage } from "../src/pages/auth/SelectOrg.js";

afterEach(() => {
  cleanup();
});

/** A fully-fake AuthClientLike -- no network, no better-auth internals. */
function createFakeAuthClient(overrides: Partial<AuthClientLike> = {}): AuthClientLike {
  return {
    useSession: () => ({ data: null, isPending: false, error: null }),
    signIn: { email: vi.fn(async () => ({ data: {}, error: null })) },
    signUp: { email: vi.fn(async () => ({ data: {}, error: null })) },
    signOut: vi.fn(async () => ({ data: {}, error: null })),
    organization: {
      create: vi.fn(async () => ({ data: { id: "org_1" }, error: null })),
      list: vi.fn(async () => ({ data: [] as OrganizationSummary[], error: null })),
      setActive: vi.fn(async () => ({ data: {}, error: null })),
    },
    ...overrides,
  };
}

function renderRouted(client: AuthClientLike, initialPath: string, element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthClientProvider client={client}>
        <Routes>
          <Route path={initialPath} element={element} />
          <Route path="/" element={<div>SHELL_PLACEHOLDER</div>} />
          <Route path="/login" element={<div>LOGIN_PAGE</div>} />
        </Routes>
      </AuthClientProvider>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  it("renders labels from the RU dictionary", () => {
    renderRouted(createFakeAuthClient(), "/login", <LoginPage />);
    expect(screen.getByText("Вход")).toBeDefined();
    expect(screen.getByLabelText("Электронная почта")).toBeDefined();
    expect(screen.getByLabelText("Пароль")).toBeDefined();
    expect(screen.getByRole("button", { name: "Войти" })).toBeDefined();
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
  it("submits sign-up details and navigates home", async () => {
    const client = createFakeAuthClient();
    renderRouted(client, "/register", <RegisterPage />);

    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Электронная почта"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Зарегистрироваться" }));

    await waitFor(() => {
      expect(client.signUp.email).toHaveBeenCalledWith({
        name: "Ada",
        email: "ada@example.com",
        password: "hunter2!",
      });
    });
    await screen.findByText("SHELL_PLACEHOLDER");
  });
});

describe("CreateOrgPage", () => {
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
    const client = createFakeAuthClient({
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

    expect(await screen.findByText("Acme Corp")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));

    await waitFor(() => {
      expect(client.organization.setActive).toHaveBeenCalledWith({ organizationId: "org_1" });
    });
    await screen.findByText("SHELL_PLACEHOLDER");
  });

  it("shows an empty state when the user has no organizations", async () => {
    renderRouted(createFakeAuthClient(), "/org/select", <SelectOrgPage />);
    expect(await screen.findByText("У вас пока нет организаций.")).toBeDefined();
  });
});
