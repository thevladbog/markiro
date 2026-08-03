import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { AuthClientProvider, type AuthClientLike } from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { ProfilePage } from "../src/pages/profile/ProfilePage.js";

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? "Service Unavailable" : "",
    json: async () => body,
  } as Response;
}

function client(signedIn = true): AuthClientLike {
  return {
    useSession: () => ({
      data: signedIn
        ? {
            session: { activeOrganizationId: null },
            user: { id: "user_1", email: "anna@example.com", name: "Анна Соколова" },
          }
        : null,
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

function renderProfile(initialPath = "/profile", signedIn = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <MemoryRouter initialEntries={[initialPath]}>
          <AuthClientProvider client={client(signedIn)}>
            <Routes>
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/catalog" element={<div>CATALOG_RETURN</div>} />
              <Route path="/login" element={<div>LOGIN_RETURN</div>} />
            </Routes>
          </AuthClientProvider>
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

describe("ProfilePage", () => {
  it("works without an active tenant, saves structured names, and returns to the requested route", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/api/profile") && !init?.method) {
          return response(200, {
            firstName: "Анна",
            lastName: "Соколова",
            middleName: "Игоревна",
            hasAvatar: true,
          });
        }
        if (url.endsWith("/api/profile/avatar-url")) {
          return response(200, { url: "https://signed.example/avatar-v1" });
        }
        if (url.endsWith("/api/profile") && init?.method === "PATCH") {
          return response(200, {
            firstName: "Анна",
            lastName: "Морозова",
            middleName: null,
            hasAvatar: true,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderProfile("/profile?complete=1&returnTo=%2Fcatalog");

    expect(await screen.findByRole("heading", { name: "Мой профиль" })).toBeDefined();
    expect(
      ((await screen.findByRole("img", { name: "Фото профиля" })) as HTMLImageElement).src,
    ).toBe("https://signed.example/avatar-v1");
    await waitFor(() =>
      expect((screen.getByLabelText("Имя") as HTMLInputElement).value).toBe("Анна"),
    );
    fireEvent.change(screen.getByLabelText("Фамилия"), { target: { value: "Морозова" } });
    fireEvent.change(screen.getByLabelText("Отчество"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(await screen.findByText("CATALOG_RETURN")).toBeDefined();
    const patch = requests.find(
      ({ url, init }) => url.endsWith("/api/profile") && init?.method === "PATCH",
    );
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      firstName: "Анна",
      lastName: "Морозова",
      middleName: null,
    });
  });

  it("uploads multipart without a JSON content type and keeps form/image state on storage failure", async () => {
    let uploadCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/profile") && !init?.method) {
          return response(200, {
            firstName: "Анна",
            lastName: "Соколова",
            middleName: null,
            hasAvatar: true,
          });
        }
        if (url.endsWith("/api/profile/avatar-url")) {
          return response(200, { url: "https://signed.example/current-avatar" });
        }
        if (url.endsWith("/api/profile/avatar") && init?.method === "POST") {
          uploadCalls += 1;
          expect(init.body).toBeInstanceOf(FormData);
          expect(new Headers(init.headers).has("Content-Type")).toBe(false);
          return response(503, { message: "object_storage_unavailable" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderProfile();

    const firstName = await screen.findByLabelText("Имя");
    fireEvent.change(firstName, { target: { value: "Анна-Мария" } });
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Загрузить фото"), { target: { files: [file] } });

    await waitFor(() => expect(uploadCalls).toBe(1));
    expect(await screen.findByText("object_storage_unavailable")).toBeDefined();
    expect((firstName as HTMLInputElement).value).toBe("Анна-Мария");
    expect((screen.getByRole("img", { name: "Фото профиля" }) as HTMLImageElement).src).toBe(
      "https://signed.example/current-avatar",
    );
  });

  it("rejects whitespace-only required names without updating the profile", async () => {
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/profile") && !init?.method) {
        return response(200, {
          firstName: "Анна",
          lastName: "Соколова",
          middleName: null,
          hasAvatar: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProfile();

    fireEvent.change(await screen.findByLabelText("Имя"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(await screen.findByText("Укажите имя и фамилию.")).toBeDefined();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).endsWith("/api/profile") && init?.method === "PATCH",
      ),
    ).toBe(false);
  });

  it("redirects anonymous users to sign in", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderProfile("/profile", false);
    expect(await screen.findByText("LOGIN_RETURN")).toBeDefined();
  });
});
