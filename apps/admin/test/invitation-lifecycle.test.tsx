import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { AuthClientProvider, type AuthClientLike, type SessionData } from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { InvitationPage } from "../src/pages/invitations/InvitationPage.js";
import { AuthQueryBoundary } from "../src/query/AuthQueryBoundary.js";

const INVITATION = {
  id: "invite_1",
  email: "invitee@example.com",
  organizationName: "М*** К***",
  role: "manager",
  state: "pending",
  expiresAt: "2026-08-10T00:00:00.000Z",
  hasAccount: false,
};

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "",
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function client(session: SessionData | null = null): AuthClientLike {
  return {
    useSession: () => ({ data: session, isPending: false, error: null }),
    useListOrganizations: () => ({ data: [], isPending: false, error: null }),
    signIn: { email: vi.fn(async () => ({ data: {}, error: null })) },
    signUp: { email: vi.fn() },
    signOut: vi.fn(async () => ({ data: {}, error: null })),
    organization: { create: vi.fn(), list: vi.fn(), setActive: vi.fn() },
  };
}

function renderInvitation(auth = client()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <MemoryRouter initialEntries={["/invitations/invite_1"]}>
          <AuthClientProvider client={auth}>
            <Routes>
              <Route path="/invitations/:id" element={<InvitationPage />} />
              <Route path="/" element={<div>CABINET_HOME</div>} />
            </Routes>
          </AuthClientProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function renderInvitationWithIdentityRefresh({
  onRefetch,
  onSignIn,
}: {
  onRefetch?: () => void;
  onSignIn?: () => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Harness() {
    const [session, setSession] = useState<SessionData | null>(null);
    const auth = client(session);
    const authenticatedSession: SessionData = {
      session: { activeOrganizationId: "org_invited" },
      user: { id: "user_invitee", email: "invitee@example.com", name: "Анна Соколова" },
    };
    auth.useSession = () => ({
      data: session,
      isPending: false,
      error: null,
      refetch: async () => {
        onRefetch?.();
        setSession(authenticatedSession);
      },
    });
    auth.signIn.email = async () => {
      onSignIn?.();
      setSession(authenticatedSession);
      return { data: {}, error: null };
    };

    return (
      <AuthClientProvider client={auth}>
        <AuthQueryBoundary>
          <Routes>
            <Route path="/invitations/:id" element={<InvitationPage />} />
            <Route path="/" element={<div>CABINET_HOME</div>} />
          </Routes>
        </AuthQueryBoundary>
      </AuthClientProvider>
    );
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <MemoryRouter initialEntries={["/invitations/invite_1"]}>
          <Harness />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

describe("InvitationPage", () => {
  it("shows a privacy-safe unavailable state for expired, canceled, used, or unknown links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(404, { message: "invitation_unavailable" })),
    );
    renderInvitation();

    expect(await screen.findByRole("heading", { name: "Ссылка недоступна" })).toBeDefined();
    expect(screen.getByText(/истечь, быть отменена или уже использована/)).toBeDefined();
  });

  it("shows a distinct rate-limit state instead of claiming the link is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(429, { message: "Too Many Requests" })),
    );
    renderInvitation();

    expect(await screen.findByRole("heading", { name: "Слишком много попыток" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Ссылка недоступна" })).toBeNull();
  });

  it("registers a new invited user and accepts the invitation", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/api/invitations/invite_1") && !init?.method) {
          return response(200, INVITATION);
        }
        if (url.endsWith("/register") && init?.method === "POST") return response(201);
        if (url.endsWith("/accept") && init?.method === "POST") return response(200);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderInvitation();

    const email = await screen.findByLabelText("Электронная почта");
    expect((email as HTMLInputElement).value).toBe("invitee@example.com");
    expect((email as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Анна" } });
    fireEvent.change(screen.getByLabelText("Фамилия"), { target: { value: "Соколова" } });
    fireEvent.change(screen.getByLabelText("Отчество"), { target: { value: "Игоревна" } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать аккаунт и принять" }));

    expect(await screen.findByText("CABINET_HOME")).toBeDefined();
    expect(requests.map(({ url }) => url).filter((url) => /register|accept/.test(url))).toEqual([
      "/api/invitations/invite_1/register",
      "/api/invitations/invite_1/accept",
    ]);
    expect(
      JSON.parse(String(requests.find(({ url }) => url.endsWith("/register"))?.init?.body)),
    ).toEqual({
      firstName: "Анна",
      lastName: "Соколова",
      middleName: "Игоревна",
      password: "password-123",
    });
  });

  it("accepts before refreshing identity and then navigates into the cabinet", async () => {
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/invitations/invite_1") && !init?.method) {
          return response(200, INVITATION);
        }
        if (url.endsWith("/register") && init?.method === "POST") {
          events.push("register");
          return response(201);
        }
        if (url.endsWith("/accept") && init?.method === "POST") {
          events.push("accept");
          return response(200);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderInvitationWithIdentityRefresh({ onRefetch: () => events.push("refetch") });

    fireEvent.change(await screen.findByLabelText("Имя"), { target: { value: "Анна" } });
    fireEvent.change(screen.getByLabelText("Фамилия"), { target: { value: "Соколова" } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать аккаунт и принять" }));

    expect(await screen.findByText("CABINET_HOME")).toBeDefined();
    expect(events).toEqual(["register", "accept", "refetch"]);
  });

  it("lets the matching signed-in account accept and rejects a different account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/invitations/invite_1") && !init?.method) {
          return response(200, { ...INVITATION, hasAccount: true });
        }
        if (url.endsWith("/accept") && init?.method === "POST") return response(200);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderInvitation(
      client({
        session: { activeOrganizationId: null },
        user: { id: "user_invitee", email: "invitee@example.com", name: "Анна" },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Принять приглашение" }));
    expect(await screen.findByRole("heading", { name: "Приглашение принято" })).toBeDefined();

    cleanup();
    renderInvitation(
      client({
        session: { activeOrganizationId: "org_other" },
        user: { id: "user_other", email: "other@example.com", name: "Другой" },
      }),
    );
    expect(await screen.findByRole("heading", { name: "Вы вошли в другой аккаунт" })).toBeDefined();
    expect(screen.getByText(/other@example\.com/)).toBeDefined();
  });

  it("signs in before presenting actions when an existing account changes identity", async () => {
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/invitations/invite_1") && !init?.method) {
          return response(200, { ...INVITATION, hasAccount: true });
        }
        if (url.endsWith("/accept") && init?.method === "POST") {
          events.push("accept");
          return response(200);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderInvitationWithIdentityRefresh({ onSignIn: () => events.push("signIn") });

    await screen.findByLabelText("Пароль");
    expect(screen.queryByRole("button", { name: "Принять приглашение" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти, чтобы продолжить" }));

    expect(await screen.findByRole("button", { name: "Принять приглашение" })).toBeDefined();
    expect(events).toEqual(["signIn"]);

    fireEvent.click(screen.getByRole("button", { name: "Принять приглашение" }));
    expect(await screen.findByRole("heading", { name: "Приглашение принято" })).toBeDefined();
    expect(events).toEqual(["signIn", "accept"]);
  });

  it("retries only acceptance after registration already succeeded and refreshes the session", async () => {
    let registerCalls = 0;
    let acceptCalls = 0;
    const refetch = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/invitations/invite_1") && !init?.method) {
          return response(200, INVITATION);
        }
        if (url.endsWith("/register")) {
          registerCalls += 1;
          return response(201);
        }
        if (url.endsWith("/accept")) {
          acceptCalls += 1;
          return acceptCalls === 1
            ? response(503, { message: "temporary_accept_failure" })
            : response(200);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const auth = client();
    auth.useSession = () => ({ data: null, isPending: false, error: null, refetch });
    renderInvitation(auth);

    fireEvent.change(await screen.findByLabelText("Имя"), { target: { value: "Анна" } });
    fireEvent.change(screen.getByLabelText("Фамилия"), { target: { value: "Соколова" } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать аккаунт и принять" }));

    expect(await screen.findByText("temporary_accept_failure")).toBeDefined();
    expect(registerCalls).toBe(1);
    expect(acceptCalls).toBe(1);
    expect(refetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Повторить принятие" }));
    expect(await screen.findByText("CABINET_HOME")).toBeDefined();
    expect(registerCalls).toBe(1);
    expect(acceptCalls).toBe(2);
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
